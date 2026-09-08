import Foundation

/// The coach loop (architecture.md §9), as a state machine over `ApexClient`
/// and an optional `ConversationStore`, so every rule is proved by
/// `swift test` on Linux. The UI (`CoachModel`, W6) is a thin observer.
///
/// One user turn: `send` → tools-on stream → text and/or tool_uses → one
/// confirmation card per tool_use, in order → each confirm executes on the
/// server (`/api/coach-tool`) → when the last settles, every tool_result goes
/// back as ONE user message and a tools-off follow-up stream speaks. Stop
/// cancels the request (which is the whole abort protocol — the server aborts
/// upstream on `close`). 402 and 429 are inline states, not toasts.
///
/// Persistence (D-013): real turns are stored with their API content; errors
/// and stopped partials are stored display-only. The tool_result row is grown
/// one result at a time *before* the next card shows, so a relaunch
/// mid-confirmation re-derives the queue from the stored tail.
public actor ChatSession {
    public struct Config: Sendable {
        public var mode: ChatMode
        /// `profiles.coach_model`; nil = let the server pick the default.
        public var model: String?
        /// The builder's / analytics' current draft, sent as `context.draft`.
        public var draft: JSONValue?
        /// The device's local calendar date, asked for per request.
        public var today: @Sendable () -> String

        public init(mode: ChatMode, model: String? = nil, draft: JSONValue? = nil, today: @escaping @Sendable () -> String) {
            self.mode = mode
            self.model = model
            self.draft = draft
            self.today = today
        }
    }

    public enum Blocked: Sendable, Equatable {
        case missingKey
        case rateLimited(until: Date)
    }

    public enum State: Sendable, Equatable {
        case idle
        case streaming
        case awaitingConfirmation(head: PendingAction, index: Int, total: Int)
        case executing(head: PendingAction, index: Int, total: Int)
        case followUp
        case blocked(Blocked)

        public var isBusy: Bool {
            switch self {
            case .streaming, .executing, .followUp: true
            case .idle, .awaitingConfirmation, .blocked: false
            }
        }
    }

    /// What the thread renders. `apiMessages` is the model's view; this is the user's.
    public struct DisplayMessage: Sendable, Equatable, Identifiable {
        public let id: String
        public let role: ApiMessage.Role
        public let text: String
        public let kind: StoredMessage.Kind
    }

    public enum Event: Sendable, Equatable {
        case state(State)
        case messages([DisplayMessage])
        /// The assistant text streamed so far in the current turn ("" when none).
        case partial(String)
        case conversation(Conversation?)
        /// A confirmed mutation landed on the server — refresh what shows it.
        case mutationConfirmed
        case toast(String)
    }

    public private(set) var config: Config
    private let client: ApexClient
    private let store: (any ConversationStore)?
    private let clock: any ApexClock

    public private(set) var state: State = .idle
    public private(set) var conversation: Conversation?
    public private(set) var apiMessages: [ApiMessage] = []
    public private(set) var messages: [DisplayMessage] = []
    public private(set) var partial = ""

    private var queue: [PendingAction] = []
    private var held: [ToolResult] = []
    private var queueTotal = 0
    /// The stored tool_result row being grown across settles, if any.
    private var toolResultRow: StoredMessage?
    private var streamTask: Task<Void, Never>?
    private var subscribers: [UUID: AsyncStream<Event>.Continuation] = [:]

    public init(
        config: Config, client: ApexClient, store: (any ConversationStore)? = nil,
        clock: any ApexClock = SystemClock()
    ) {
        self.config = config
        self.client = client
        self.store = store
        self.clock = clock
    }

    // MARK: - Observation

    /// A fresh stream per caller — `AsyncStream` is single-consumer.
    public func subscribe() -> AsyncStream<Event> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<Event>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        return stream
    }

    private func unsubscribe(_ id: UUID) { subscribers[id] = nil }

    private func emit(_ event: Event) {
        for continuation in subscribers.values { continuation.yield(event) }
    }

    private func setState(_ new: State) {
        state = new
        emit(.state(new))
    }

    private func setPartial(_ text: String) {
        partial = text
        emit(.partial(text))
    }

    // MARK: - Configuration

    public func update(model: String?) { config.model = model }
    public func update(draft: JSONValue?) { config.draft = draft }

    /// After the key sheet saved a key: the 402 block lifts.
    public func keyAdded() {
        if case .blocked(.missingKey) = state { setState(.idle) }
    }

    /// Nothing in flight, nothing awaiting the user, and either not blocked or
    /// the rate-limit window has passed.
    public var canSend: Bool {
        switch state {
        case .idle: true
        case .blocked(.rateLimited(let until)): clock.now >= until
        default: false
        }
    }

    // MARK: - Conversations

    /// Open a stored conversation and re-derive where it stood.
    public func load(conversationId: String) async {
        guard let store else { return }
        stop()
        guard let stored = try? await store.conversation(id: conversationId) else { return }
        let rows = (try? await store.messages(in: conversationId)) ?? []
        conversation = stored
        apiMessages = rows.compactMap(\.apiMessage)
        messages = rows.compactMap { row in
            row.displayText.map { DisplayMessage(id: row.id, role: row.role, text: $0, kind: row.kind) }
        }
        queue = []
        held = []
        queueTotal = 0
        toolResultRow = nil
        setPartial("")

        if let tail = ActionQueue.pendingTail(apiMessages) {
            let actions = ActionQueue.toPendingActions(tail.toolUses)
            queueTotal = actions.count
            held = tail.settled
            queue = Array(actions.dropFirst(tail.settled.count))
            if !tail.settled.isEmpty {
                // The partial tool_result message is held, not history, until it flushes.
                apiMessages.removeLast()
                toolResultRow = rows.last { $0.kind == .turn && $0.role == .user }
            }
            emit(.conversation(conversation))
            emit(.messages(messages))
            setState(.awaitingConfirmation(head: queue[0], index: tail.settled.count + 1, total: queueTotal))
        } else {
            emit(.conversation(conversation))
            emit(.messages(messages))
            setState(blockedState ?? .idle)
        }
    }

    /// An empty thread. The row is created on the first message so an
    /// abandoned "new" never litters the list.
    public func startNewConversation() {
        stop()
        conversation = nil
        apiMessages = []
        messages = []
        queue = []
        held = []
        queueTotal = 0
        toolResultRow = nil
        setPartial("")
        emit(.conversation(nil))
        emit(.messages(messages))
        setState(blockedState ?? .idle)
    }

    /// A missing-key block outlives a conversation switch; a rate limit too,
    /// until its window passes.
    private var blockedState: State? {
        switch state {
        case .blocked(.missingKey): return state
        case .blocked(.rateLimited(let until)) where clock.now < until: return state
        default: return nil
        }
    }

    // MARK: - Turns

    /// Send a user message. Ignored while a turn is in flight, a card is
    /// showing, or the coach is blocked; the UI disables the composer in those
    /// states and this is the backstop.
    public func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !trimmed.isEmpty else { return }
        await ensureConversation(title: ChatCopy.title(from: trimmed))

        let folded = apiMessages.last.map { $0.role == .user && $0.content.blocks != nil } ?? false
        apiMessages = ActionQueue.appendUserText(apiMessages, trimmed)
        var foldTarget = toolResultRow
        if folded, foldTarget == nil { foldTarget = await lastStoredUserTurn }
        if folded, var row = foldTarget {
            // The follow-up never came: the text joins the unanswered
            // tool_result message, as one row.
            row.apiContent = apiMessages.last?.content
            row.displayText = trimmed
            await persistUpdate(row)
            toolResultRow = nil
            appendDisplay(DisplayMessage(id: row.id, role: .user, text: trimmed, kind: .turn))
        } else {
            let row = await persistAppend(role: .user, apiContent: .text(trimmed), displayText: trimmed, kind: .turn)
            appendDisplay(DisplayMessage(id: row.id, role: .user, text: trimmed, kind: .turn))
        }

        await stream(withTools: true, failureCopy: ChatCopy.genericFailure)
    }

    /// Coach's Notes: a tools-off briefing in a conversation of its own. The
    /// prompt row is stored but hidden, so the thread opens on the coach.
    public func notes() async {
        guard canSend else { return }
        startNewConversation()
        await ensureConversation(title: "\(ChatCopy.notesTitle) · \(config.today())")
        apiMessages = [.user(ChatCopy.notesPrompt)]
        _ = await persistAppend(role: .user, apiContent: .text(ChatCopy.notesPrompt), displayText: nil, kind: .turn)
        await stream(withTools: false, failureCopy: ChatCopy.notesFailure)
    }

    /// Cancel the request in flight. The server sees the close and aborts the
    /// upstream call; whatever text had arrived stays on screen, display-only.
    public func stop() {
        streamTask?.cancel()
    }

    // MARK: - Confirmation

    public func confirmHead() async {
        guard case .awaitingConfirmation(let head, let index, let total) = state else { return }
        setState(.executing(head: head, index: index, total: total))
        let resultText: String
        do {
            let response = try await client.send(
                .coachTool(toolUseId: head.toolUseId, name: head.toolName, input: head.input, today: config.today()),
                as: CoachToolResponse.self
            )
            resultText = response.resultText ?? "Done."
            if response.ok { emit(.mutationConfirmed) }
        } catch let error as APIError {
            if case .rateLimited = error {
                emit(.toast(ChatCopy.aiCapReached))
            } else {
                emit(.toast(ChatCopy.applyFailed))
            }
            resultText = ChatCopy.executorFailed
        } catch {
            emit(.toast(ChatCopy.applyFailed))
            resultText = ChatCopy.executorFailed
        }
        await settle(resultText, failureCopy: ChatCopy.confirmTroubled)
    }

    public func cancelHead() async {
        guard case .awaitingConfirmation = state else { return }
        await settle(ChatCopy.cancelledByUser, failureCopy: nil)
    }

    /// Advance the queue by one result. The stored tool_result row grows now,
    /// before the next card, so a relaunch resumes at the next unsettled
    /// action rather than re-presenting a done one.
    private func settle(_ resultText: String, failureCopy: String?) async {
        let settled = ActionQueue.settleHead(queue: queue, results: held, resultText: resultText)
        queue = settled.queue
        held = settled.results
        let results = settled.flushed ?? settled.results

        if var row = toolResultRow {
            row.apiContent = .blocks(results.map(ContentBlock.toolResult))
            await persistUpdate(row)
            toolResultRow = row
        } else {
            toolResultRow = await persistAppend(
                role: .user, apiContent: .blocks(results.map(ContentBlock.toolResult)), displayText: nil, kind: .turn
            )
        }

        if let flushed = settled.flushed {
            apiMessages.append(.user(toolResults: flushed))
            toolResultRow = nil
            queueTotal = 0
            await stream(withTools: false, failureCopy: failureCopy)
        } else {
            setState(.awaitingConfirmation(head: queue[0], index: queueTotal - queue.count + 1, total: queueTotal))
        }
    }

    // MARK: - Streaming

    /// One `/api/chat` call. Runs in its own task so `stop()` has a handle;
    /// the caller awaits it, so `send` returns when the turn has settled into
    /// its next state.
    private func stream(withTools: Bool, failureCopy: String?) async {
        setPartial("")
        setState(withTools ? .streaming : .followUp)
        let request = Endpoint.chat(
            mode: config.mode, messages: ActionQueue.historyWindow(apiMessages), withTools: withTools,
            today: config.today(), draft: config.draft, model: config.model
        )
        let task = Task { [client] in
            var text = ""
            var toolUses: [ToolUseBlock] = []
            do {
                let events = try await client.wireEvents(for: request)
                for try await event in events {
                    switch event {
                    case .text(let delta):
                        text += delta
                        self.setPartial(text)
                    case .toolUse:
                        if let block = ToolUseBlock(event) { toolUses.append(block) }
                    case .done:
                        break
                    case .error(let message):
                        throw APIError.server(status: 200, message: message)
                    }
                }
                if Task.isCancelled {
                    await self.finishStopped(partial: text)
                } else {
                    await self.finishStream(text: text, toolUses: toolUses, withTools: withTools)
                }
            } catch {
                if Task.isCancelled {
                    await self.finishStopped(partial: text)
                } else {
                    await self.finishFailed(error, partial: text, failureCopy: failureCopy)
                }
            }
        }
        streamTask = task
        await task.value
        if streamTask == task { streamTask = nil }
    }

    private func finishStream(text: String, toolUses: [ToolUseBlock], withTools: Bool) async {
        setPartial("")
        guard let assistant = ActionQueue.assistantMessage(text: text, toolUses: toolUses) else {
            if withTools { await notice(ChatCopy.emptyReply) }
            setState(.idle)
            return
        }
        apiMessages.append(assistant)
        let row = await persistAppend(
            role: .assistant, apiContent: assistant.content, displayText: text.isEmpty ? nil : text, kind: .turn
        )
        if !text.isEmpty { appendDisplay(DisplayMessage(id: row.id, role: .assistant, text: text, kind: .turn)) }

        if toolUses.isEmpty {
            setState(.idle)
        } else {
            queue = ActionQueue.toPendingActions(toolUses)
            held = []
            queueTotal = queue.count
            toolResultRow = nil
            setState(.awaitingConfirmation(head: queue[0], index: 1, total: queueTotal))
        }
    }

    private func finishStopped(partial text: String) async {
        setPartial("")
        if !text.isEmpty { await notice(text, kind: .stopped) }
        setState(.idle)
    }

    private func finishFailed(_ error: Error, partial text: String, failureCopy: String?) async {
        setPartial("")
        if !text.isEmpty { await notice(text, kind: .stopped) }
        switch error as? APIError {
        case .missingAnthropicKey:
            await notice(ChatCopy.keySetup)
            setState(.blocked(.missingKey))
        case .rateLimited(let retryAfter):
            await notice(ChatCopy.rateLimited)
            setState(.blocked(.rateLimited(until: clock.now.addingTimeInterval(retryAfter ?? 600))))
        default:
            if let failureCopy { await notice(failureCopy) }
            setState(.idle)
        }
    }

    // MARK: - Persistence

    private func ensureConversation(title: String) async {
        guard conversation == nil else { return }
        let now = clock.now
        let created = Conversation(id: Self.newId(), mode: config.mode, title: title, createdAt: now, updatedAt: now)
        conversation = created
        try? await store?.create(created)
        emit(.conversation(created))
    }

    @discardableResult
    private func persistAppend(
        role: ApiMessage.Role, apiContent: ApiMessage.Content?, displayText: String?, kind: StoredMessage.Kind
    ) async -> StoredMessage {
        let row = StoredMessage(
            id: Self.newId(), conversationId: conversation?.id ?? "", role: role,
            apiContent: apiContent, displayText: displayText, kind: kind, createdAt: clock.now
        )
        if let store, let conversation {
            try? await store.append(row)
            try? await store.touch(id: conversation.id, at: row.createdAt)
            self.conversation?.updatedAt = row.createdAt
        }
        return row
    }

    private func persistUpdate(_ row: StoredMessage) async {
        if let store, let conversation {
            try? await store.update(row)
            try? await store.touch(id: conversation.id, at: clock.now)
        }
    }

    /// The stored row behind the trailing tool_result message, when `load`
    /// rebuilt history from a complete flush that never got its follow-up.
    private var lastStoredUserTurn: StoredMessage? {
        get async {
            guard let store, let conversation else { return nil }
            let rows = (try? await store.messages(in: conversation.id)) ?? []
            return rows.last { $0.role == .user && $0.kind == .turn && $0.apiContent?.blocks != nil }
        }
    }

    private func notice(_ text: String, kind: StoredMessage.Kind = .notice) async {
        let row = await persistAppend(role: .assistant, apiContent: nil, displayText: text, kind: kind)
        appendDisplay(DisplayMessage(id: row.id, role: .assistant, text: text, kind: kind))
    }

    private func appendDisplay(_ message: DisplayMessage) {
        messages.append(message)
        emit(.messages(messages))
    }

    private static func newId() -> String { UUID().uuidString.lowercased() }
}
