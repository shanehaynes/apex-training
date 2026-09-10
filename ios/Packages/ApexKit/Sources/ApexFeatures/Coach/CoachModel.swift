import ApexCore
import ApexUI
import Foundation
import Observation

/// The Coach tab's state (D-006): a thin, observable mirror of one
/// `ChatSession` plus the things only the UI knows — the profile's key status
/// and model label, the conversation list, the composer text, the confirm
/// latch, and the haptic counter. Every rule about turns, cards and
/// persistence lives in `ApexCore.ChatSession`; this class only forwards.
@MainActor
@Observable
public final class CoachModel {
    public private(set) var state: ChatSession.State = .idle
    public private(set) var messages: [ChatSession.DisplayMessage] = []
    public private(set) var partial = ""
    public private(set) var conversation: Conversation?
    public private(set) var conversations: [Conversation] = []
    public private(set) var profile: ProfileResponse?
    public private(set) var isStarted = false
    /// `.sensoryFeedback` trigger (design-spec §9): bump, never reset.
    public private(set) var confirmCount = 0
    /// The synchronous double-tap guard: set before any await on confirm/cancel.
    public private(set) var isActionLatched = false

    public var composerText = ""
    public var showConversations = false
    public var showKeySheet = false

    public let session: ChatSession
    public let mode: ChatMode
    private let services: CoachServices
    private let onDraft: ((JSONValue) -> Void)?
    private let placeholder: String?
    private var eventsTask: Task<Void, Never>?
    private var markers: [UUID: CheckedContinuation<Void, Never>] = [:]

    /// `.chat` persists conversations per owner; the draft modes (builder,
    /// analytics) are store-less like the web's panels and carry `draft` as
    /// the session's context — every reduce comes back through `onDraft`.
    public init(
        services: CoachServices, mode: ChatMode = .chat, draft: JSONValue? = nil,
        onDraft: ((JSONValue) -> Void)? = nil, placeholder: String? = nil
    ) {
        self.services = services
        self.mode = mode
        self.onDraft = onDraft
        self.placeholder = placeholder
        let clock = services.clock
        let timeZone = services.timeZone
        self.session = ChatSession(
            config: .init(mode: mode, draft: draft, today: { DayKey.today(clock: clock, timeZone: timeZone).string }),
            client: services.client, store: mode == .chat ? services.store : nil, clock: clock
        )
    }

    /// The form changed: the next reduce must start from what the user sees
    /// (the web's `draftRef` rule).
    public func updateDraft(_ draft: JSONValue) {
        Task { [session] in await session.update(draft: draft) }
    }

    // MARK: - Derived

    /// No key on file (from the profile) or the server said so (402).
    public var needsKey: Bool {
        if case .blocked(.missingKey) = state { return true }
        return profile.map { !$0.hasAnthropicKey } ?? false
    }

    public var pending: (action: PendingAction, index: Int, total: Int)? {
        switch state {
        case .awaitingConfirmation(let head, let index, let total), .executing(let head, let index, let total):
            return (head, index, total)
        default:
            return nil
        }
    }

    public var isExecuting: Bool { if case .executing = state { return true } else { return false } }
    public var isStreaming: Bool { state == .streaming || state == .followUp }
    public var rateLimitedUntil: Date? {
        if case .blocked(.rateLimited(let until)) = state, until > services.clock.now { return until }
        return nil
    }

    /// Notes and a fresh send share the same preconditions.
    public var canStartTurn: Bool {
        !needsKey && pending == nil && !isStreaming && rateLimitedUntil == nil
    }

    public var canSend: Bool {
        canStartTurn && !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var composerPlaceholder: String {
        if needsKey { return ChatCopy.placeholderNeedsKey }
        if pending != nil { return ChatCopy.placeholderPending }
        return placeholder ?? ChatCopy.placeholder
    }

    public var modelLabel: String? { profile?.coachModelLabel }
    /// For the key sheet, which talks to `/api/profile` itself.
    public var client: ApexClient { services.client }

    // MARK: - Lifecycle

    /// Subscribe, learn the key status and model, and open the most recent
    /// conversation. Idempotent — the tab's `.task` runs on every appearance.
    public func start() async {
        guard !isStarted else { return }
        isStarted = true
        let stream = await session.subscribe()
        eventsTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.handle(event)
            }
        }
        await refreshProfile()
        await refreshConversations()
        if let latest = conversations.first {
            await session.load(conversationId: latest.id)
        }
        await sync()
    }

    /// Wait until every event the session has emitted so far has been applied.
    /// The mirror is fed only by the ordered event stream (never by reading the
    /// session directly, which could be overtaken by a buffered older event);
    /// a marker emitted now is delivered after everything before it, so the end
    /// of every awaited action is deterministic.
    private func sync() async {
        guard eventsTask != nil else { return }
        let id = UUID()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            markers[id] = continuation
            Task { [session] in await session.mark(id) }
        }
    }

    /// Sign-out: stop listening. The rows stay, per owner.
    public func shutdown() {
        eventsTask?.cancel()
        eventsTask = nil
        for continuation in markers.values { continuation.resume() }
        markers = [:]
        Task { await session.stop() }
    }

    public func refreshProfile() async {
        guard let loaded = try? await services.client.send(.profile, as: ProfileResponse.self) else { return }
        profile = loaded
        await session.update(model: loaded.coachModel)
        if loaded.hasAnthropicKey { await session.keyAdded() }
    }

    public func refreshConversations() async {
        guard mode == .chat else { return }
        conversations = (try? await services.store.conversations(mode: .chat)) ?? []
    }

    // MARK: - Actions (each returns its task so tests can await it)

    @discardableResult
    public func send() -> Task<Void, Never> {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        composerText = ""
        return Task { [session] in
            await session.send(text)
            await self.sync()
            await self.refreshConversations()
        }
    }

    @discardableResult
    public func confirm() -> Task<Void, Never> {
        guard !isActionLatched, case .awaitingConfirmation = state else { return Task {} }
        isActionLatched = true
        confirmCount += 1
        return Task { [session] in
            await session.confirmHead()
            await self.sync()
            self.isActionLatched = false
        }
    }

    @discardableResult
    public func cancel() -> Task<Void, Never> {
        guard !isActionLatched, case .awaitingConfirmation = state else { return Task {} }
        isActionLatched = true
        return Task { [session] in
            await session.cancelHead()
            await self.sync()
            self.isActionLatched = false
        }
    }

    public func stop() {
        Task { [session] in await session.stop() }
    }

    @discardableResult
    public func notes() -> Task<Void, Never> {
        Task { [session] in
            await session.notes()
            await self.sync()
            await self.refreshConversations()
        }
    }

    @discardableResult
    public func newConversation() -> Task<Void, Never> {
        showConversations = false
        return Task { [session] in
            await session.startNewConversation()
            await self.sync()
        }
    }

    @discardableResult
    public func resume(_ id: String) -> Task<Void, Never> {
        showConversations = false
        return Task { [session] in
            await session.load(conversationId: id)
            await self.sync()
        }
    }

    @discardableResult
    public func delete(_ id: String) -> Task<Void, Never> {
        Task { [session, services] in
            try? await services.store.delete(id: id)
            if self.conversation?.id == id { await session.startNewConversation() }
            await self.sync()
            await self.refreshConversations()
        }
    }

    /// After the key sheet saved (or removed) a key.
    public func keyChanged(_ status: ProfileResponse?) async {
        showKeySheet = false
        if let status { profile = status }
        await refreshProfile()
        await sync()
    }

    // MARK: - Events

    private func handle(_ event: ChatSession.Event) {
        switch event {
        case .state(let new):
            state = new
        case .messages(let list):
            messages = list
        case .partial(let text):
            partial = text
        case .conversation(let current):
            conversation = current
            Task { await refreshConversations() }
        case .mutationConfirmed:
            services.onMutationConfirmed()
        case .draft(let draft):
            onDraft?(draft)
        case .toast(let text):
            ToastBus.shared.post(text, level: .failure)
        case .marker(let id):
            markers.removeValue(forKey: id)?.resume()
        }
    }
}
