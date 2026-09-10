import XCTest
@testable import ApexCore

/// The coach loop against a scripted transport and an in-memory store. Every
/// rule in architecture.md §9 and the D-013 persistence decisions is here.
final class ChatSessionTests: XCTestCase {
    private let today = "2026-09-08"
    private let now = Date(timeIntervalSince1970: 1_788_868_800)

    // MARK: - Fixtures

    private var fixtureLines: [String] {
        get throws {
            String(decoding: try TestFixtures.data("chat-stream.ndjson"), as: UTF8.self)
                .split(separator: "\n").map(String.init)
        }
    }
    private let fixtureLabel = "Delete: Fixture Push Day · 2026-09-29 (this instance)"
    private let coachToolOK = #"{"ok":true,"resultText":"Deleted Fixture Push Day on 2026-09-29."}"#

    private func text(_ deltas: String..., done: Bool = true) -> [String] {
        deltas.map { #"{"type":"text","delta":"\#($0)"}"# } + (done ? [#"{"type":"done"}"#] : [])
    }

    private func toolUse(_ id: String, name: String = "delete_event", label: String? = nil) -> String {
        let labelPart = label.map { #","label":"\#($0)""# } ?? ""
        return #"{"type":"tool_use","id":"\#(id)","name":"\#(name)","input":{"event_id":"\#(id)","scope":"all"}\#(labelPart)}"#
    }

    private func makeSession(
        _ transport: ScriptedTransport, store: MemoryConversationStore? = MemoryConversationStore(),
        clock: TestClock? = nil, mode: ChatMode = .chat, model: String? = nil, draft: JSONValue? = nil
    ) -> ChatSession {
        let today = self.today
        return ChatSession(
            config: .init(mode: mode, model: model, draft: draft, today: { today }),
            client: makeClient(transport), store: store, clock: clock ?? TestClock(now: now)
        )
    }

    /// Collects the session's events so a test can assert on them after the fact.
    private actor Events {
        private(set) var all: [ChatSession.Event] = []
        private var task: Task<Void, Never>?
        func start(_ stream: AsyncStream<ChatSession.Event>) {
            task = Task { for await event in stream { await self.append(event) } }
        }
        private func append(_ event: ChatSession.Event) { all.append(event) }
        func contains(_ event: ChatSession.Event) async -> Bool {
            let deadline = Date().addingTimeInterval(2)
            while !all.contains(event), Date() < deadline { try? await Task.sleep(nanoseconds: 5_000_000) }
            return all.contains(event)
        }
        func stop() { task?.cancel() }
    }

    private func waitUntil(_ condition: @escaping @Sendable () async -> Bool, timeout: Double = 2) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return await condition()
    }

    private func messages(of request: RecordedRequest) -> [[String: Any]] {
        request.body?["messages"] as? [[String: Any]] ?? []
    }

    // MARK: - Plain turns

    func testSendStreamsTextAndPersistsBothTurns() async throws {
        let store = MemoryConversationStore()
        let transport = ScriptedTransport([.ndjson(text("Hello ", "there."))])
        let session = makeSession(transport, store: store)

        await session.send("hi")

        let v1 = await session.state
        XCTAssertEqual(v1, .idle)
        let v2 = await session.apiMessages
        XCTAssertEqual(v2, [.user("hi"), .assistant("Hello there.")])
        let v3 = await session.messages.map(\.text)
        XCTAssertEqual(v3, ["hi", "Hello there."])
        let v4 = await session.partial
        XCTAssertEqual(v4, "")

        let u101 = await transport.requests.first
        let request = try XCTUnwrap(u101)
        XCTAssertEqual(request.path, "/api/chat")
        XCTAssertEqual(request.body?["mode"] as? String, "chat")
        XCTAssertEqual(request.body?["withTools"] as? Bool, true)
        XCTAssertEqual(request.body?["today"] as? String, today)
        XCTAssertNil(request.body?["model"])
        XCTAssertNil(request.body?["context"])
        XCTAssertEqual(messages(of: request).count, 1)

        let conversations = try await store.conversations(mode: .chat)
        XCTAssertEqual(conversations.count, 1)
        XCTAssertEqual(conversations[0].title, "hi")
        let rows = try await store.messages(in: conversations[0].id)
        XCTAssertEqual(rows.map(\.kind), [.turn, .turn])
        XCTAssertEqual(rows.map(\.role), [.user, .assistant])
        XCTAssertEqual(rows[1].apiContent, .text("Hello there."))
    }

    func testPartialTextStreamsDeltaByDelta() async throws {
        let gate = Gate()
        let transport = ScriptedTransport([.ndjson(text("Hello ", done: false), holdOpen: gate)])
        let session = makeSession(transport)
        let events = Events()
        await events.start(await session.subscribe())

        let sending = Task { await session.send("hi") }
        let v5 = await waitUntil { await session.partial == "Hello " }
        XCTAssertTrue(v5)
        let v6 = await session.state
        XCTAssertEqual(v6, .streaming)
        await gate.open()
        await sending.value
        let v7 = await events.contains(.partial("Hello "))
        XCTAssertTrue(v7)
        let v8 = await session.messages.last?.text
        XCTAssertEqual(v8, "Hello ")
        await events.stop()
    }

    // MARK: - Tool use and confirmation

    func testToolUseEntersAwaitingConfirmationOneOfOne() async throws {
        let store = MemoryConversationStore()
        let transport = ScriptedTransport([.ndjson(try fixtureLines)])
        let session = makeSession(transport, store: store)

        await session.send("skip next week")

        guard case .awaitingConfirmation(let head, let index, let total) = await session.state else {
            return XCTFail("expected a card, got \(await session.state)")
        }
        XCTAssertEqual(head.displayLabel, fixtureLabel)
        XCTAssertEqual(head.toolName, "delete_event")
        XCTAssertEqual(head.toolUseId, "toolu_fixture")
        XCTAssertEqual(index, 1)
        XCTAssertEqual(total, 1)
        let v9 = await session.messages.map(\.text)
        XCTAssertEqual(v9, ["skip next week", "Clearing it. "])
        // The label is kept locally (a card must survive a relaunch)…
        let u102 = await session.apiMessages.last
        let assistant = try XCTUnwrap(u102)
        XCTAssertEqual(assistant.toolUses.first?.label, fixtureLabel)
        let u103 = await session.conversation?.id
        let rows = try await store.messages(in: try XCTUnwrap(u103))
        XCTAssertEqual(rows.last?.apiMessage?.toolUses.first?.label, fixtureLabel)
        // …and a send while the card shows is ignored.
        await session.send("more")
        let v10 = await transport.count
        XCTAssertEqual(v10, 1)
        let v11 = await session.messages.count
        XCTAssertEqual(v11, 2)
    }

    func testConfirmExecutesFlushesOneMessageAndFollowsUpToolsOff() async throws {
        let transport = ScriptedTransport([.ndjson(try fixtureLines), .ok(coachToolOK), .ndjson(text("Cleared."))])
        let session = makeSession(transport, model: "claude-sonnet-5")
        let events = Events()
        await events.start(await session.subscribe())

        await session.send("skip next week")
        await session.confirmHead()

        let v12 = await session.state
        XCTAssertEqual(v12, .idle)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat", "/api/coach-tool", "/api/chat"])

        let tool = requests[1]
        XCTAssertEqual(tool.body?["toolUseId"] as? String, "toolu_fixture")
        XCTAssertEqual(tool.body?["name"] as? String, "delete_event")
        XCTAssertEqual((tool.body?["input"] as? [String: Any])?["scope"] as? String, "instance")
        XCTAssertEqual(tool.body?["today"] as? String, today)

        let followUp = requests[2]
        XCTAssertEqual(followUp.body?["withTools"] as? Bool, false)
        XCTAssertEqual(followUp.body?["mode"] as? String, "chat")
        XCTAssertEqual(followUp.body?["model"] as? String, "claude-sonnet-5")
        XCTAssertEqual(followUp.body?["today"] as? String, today)
        XCTAssertFalse(followUp.bodyText.contains("label"))
        let history = messages(of: followUp)
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0]["content"] as? String, "skip next week")
        let assistantBlocks = try XCTUnwrap(history[1]["content"] as? [[String: Any]])
        XCTAssertEqual(assistantBlocks.map { $0["type"] as? String }, ["text", "tool_use"])
        let results = try XCTUnwrap(history[2]["content"] as? [[String: Any]])
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0]["tool_use_id"] as? String, "toolu_fixture")
        XCTAssertEqual(results[0]["content"] as? String, "Deleted Fixture Push Day on 2026-09-29.")

        let v13 = await events.contains(.mutationConfirmed)
        XCTAssertTrue(v13)
        let v14 = await session.messages.map(\.text)
        XCTAssertEqual(v14, ["skip next week", "Clearing it. ", "Cleared."])
        let v15 = await session.apiMessages.count
        XCTAssertEqual(v15, 4)
        await events.stop()
    }

    func testCancelSendsCancelledByUserWithoutExecuting() async throws {
        let transport = ScriptedTransport([.ndjson(try fixtureLines), .ndjson(text("Left it alone."))])
        let session = makeSession(transport)
        let events = Events()
        await events.start(await session.subscribe())

        await session.send("skip next week")
        await session.cancelHead()

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat", "/api/chat"])
        let results = try XCTUnwrap(messages(of: requests[1]).last?["content"] as? [[String: Any]])
        XCTAssertEqual(results[0]["content"] as? String, ChatCopy.cancelledByUser)
        let v16 = await events.all.contains(.mutationConfirmed)
        XCTAssertFalse(v16)
        let v17 = await session.messages.last?.text
        XCTAssertEqual(v17, "Left it alone.")
        await events.stop()
    }

    func testThreeActionsAdvanceTheIndexAndFlushOnce() async throws {
        let store = MemoryConversationStore()
        let stream = text("On it. ", done: false) + [toolUse("tu_1", label: "A"), toolUse("tu_2", label: "B"), toolUse("tu_3", name: "not_a_real_tool"), #"{"type":"done"}"#]
        let transport = ScriptedTransport([.ndjson(stream), .ok(#"{"ok":true,"resultText":"Done."}"#), .ok(#"{"ok":true,"resultText":"Done."}"#), .ndjson(text("All set."))])
        let session = makeSession(transport, store: store)

        await session.send("clear the week")
        guard case .awaitingConfirmation(let first, 1, 3) = await session.state else { return XCTFail("\(await session.state)") }
        XCTAssertEqual(first.displayLabel, "A")

        await session.confirmHead()
        guard case .awaitingConfirmation(let second, 2, 3) = await session.state else { return XCTFail("\(await session.state)") }
        XCTAssertEqual(second.displayLabel, "B")
        // The stored tool_result row already carries the first result.
        let u104 = await session.conversation?.id
        let conversationId = try XCTUnwrap(u104)
        let mid = try await store.messages(in: conversationId).filter { $0.role == .user && $0.apiContent?.blocks != nil }
        XCTAssertEqual(mid.count, 1)
        XCTAssertEqual(mid[0].apiMessage?.toolResults.map(\.content), ["Done."])

        await session.cancelHead()
        guard case .awaitingConfirmation(let third, 3, 3) = await session.state else { return XCTFail("\(await session.state)") }
        XCTAssertEqual(third.displayLabel, "not_a_real_tool")

        await session.confirmHead()
        let v18 = await session.state
        XCTAssertEqual(v18, .idle)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat", "/api/coach-tool", "/api/coach-tool", "/api/chat"])
        let flushed = try XCTUnwrap(messages(of: requests[3]).last?["content"] as? [[String: Any]])
        XCTAssertEqual(flushed.map { $0["tool_use_id"] as? String }, ["tu_1", "tu_2", "tu_3"])
        XCTAssertEqual(flushed.map { $0["content"] as? String }, ["Done.", ChatCopy.cancelledByUser, "Done."])

        // One grown row, not three.
        let rows = try await store.messages(in: conversationId)
        let resultRows = rows.filter { $0.role == .user && $0.apiContent?.blocks != nil }
        XCTAssertEqual(resultRows.count, 1)
        XCTAssertEqual(resultRows[0].apiMessage?.toolResults.count, 3)
        XCTAssertEqual(rows.map(\.role), [.user, .assistant, .user, .assistant])
    }

    func testCoachToolFailureUsesTheWebFailureTextAndToasts() async throws {
        let transport = ScriptedTransport([.ndjson(try fixtureLines), .status(500, body: "Tool execution failed"), .ndjson(text("Hm."))])
        let session = makeSession(transport)
        let events = Events()
        await events.start(await session.subscribe())

        await session.send("skip")
        await session.confirmHead()

        let r1 = await transport.requests[2]
        let results = try XCTUnwrap(messages(of: r1).last?["content"] as? [[String: Any]])
        XCTAssertEqual(results[0]["content"] as? String, ChatCopy.executorFailed)
        let v19 = await events.contains(.toast(ChatCopy.applyFailed))
        XCTAssertTrue(v19)
        let v20 = await events.all.contains(.mutationConfirmed)
        XCTAssertFalse(v20)
        await events.stop()
    }

    func testCoachToolCapPostsTheCapToast() async throws {
        let transport = ScriptedTransport([
            .ndjson(try fixtureLines),
            .status(429, body: "Daily AI mutation cap reached.", headers: ["Retry-After": "3600"]),
            .ndjson(text("Hm.")),
        ])
        let session = makeSession(transport)
        let events = Events()
        await events.start(await session.subscribe())
        await session.send("skip")
        await session.confirmHead()
        let v21 = await events.contains(.toast(ChatCopy.aiCapReached))
        XCTAssertTrue(v21)
        let v22 = await session.state
        XCTAssertEqual(v22, .idle)
        await events.stop()
    }

    func testFollowUpFailureAfterConfirmShowsTheTroubleNotice() async throws {
        let transport = ScriptedTransport([.ndjson(try fixtureLines), .ok(coachToolOK), .status(500)])
        let session = makeSession(transport)
        await session.send("skip")
        await session.confirmHead()
        let v23 = await session.state
        XCTAssertEqual(v23, .idle)
        let v24 = await session.messages.last?.text
        XCTAssertEqual(v24, ChatCopy.confirmTroubled)
        let v25 = await session.messages.last?.kind
        XCTAssertEqual(v25, .notice)
        // The flush stays in history so the next send folds into it.
        let v26 = await session.apiMessages.last?.toolResults.count
        XCTAssertEqual(v26, 1)
    }

    func testFollowUpFailureAfterCancelShowsNothing() async throws {
        let transport = ScriptedTransport([.ndjson(try fixtureLines), .status(500)])
        let session = makeSession(transport)
        await session.send("skip")
        await session.cancelHead()
        let v27 = await session.state
        XCTAssertEqual(v27, .idle)
        let v28 = await session.messages.map(\.text)
        XCTAssertEqual(v28, ["skip", "Clearing it. "])
    }

    // MARK: - Stop

    func testStopMidStreamCancelsTheRequestKeepsThePartialAndPersistsNoApiTurn() async throws {
        let store = MemoryConversationStore()
        let gate = Gate()
        let transport = ScriptedTransport([.ndjson(text("Clearing ", done: false), holdOpen: gate)])
        let session = makeSession(transport, store: store)

        let sending = Task { await session.send("skip") }
        let v29 = await waitUntil { await session.partial == "Clearing " }
        XCTAssertTrue(v29)
        await session.stop()
        await sending.value

        let v30 = await session.state
        XCTAssertEqual(v30, .idle)
        let v31 = await session.partial
        XCTAssertEqual(v31, "")
        let v32 = await session.apiMessages
        XCTAssertEqual(v32, [.user("skip")])
        let u105 = await session.messages.last
        let last = try XCTUnwrap(u105)
        XCTAssertEqual(last.text, "Clearing ")
        XCTAssertEqual(last.kind, .stopped)
        let v33 = await waitUntil { await transport.streamCancellations == 1 }
        XCTAssertTrue(v33)

        let u106 = await session.conversation?.id
        let rows = try await store.messages(in: try XCTUnwrap(u106))
        XCTAssertEqual(rows.map(\.kind), [.turn, .stopped])
        XCTAssertNil(rows[1].apiContent)
        let v34 = await session.canSend
        XCTAssertTrue(v34)
    }

    func testStopDuringTheFollowUpThenTheNextSendFoldsIntoTheToolResultMessage() async throws {
        let store = MemoryConversationStore()
        let gate = Gate()
        let transport = ScriptedTransport([.ndjson(try fixtureLines), .ok(coachToolOK), .ndjson(text("Cle", done: false), holdOpen: gate)])
        let session = makeSession(transport, store: store)

        await session.send("skip")
        let confirming = Task { await session.confirmHead() }
        let v35 = await waitUntil { await session.partial == "Cle" }
        XCTAssertTrue(v35)
        let v36 = await session.state
        XCTAssertEqual(v36, .followUp)
        await session.stop()
        await confirming.value
        let v37 = await session.state
        XCTAssertEqual(v37, .idle)
        let v38 = await session.apiMessages.count
        XCTAssertEqual(v38, 3)
        let v39 = await session.apiMessages.last?.toolResults.count
        XCTAssertEqual(v39, 1)

        await transport.script([.ndjson(text("Yes, it's gone."))])
        await session.send("did that work?")

        let u107 = await transport.requests.last
        let request = try XCTUnwrap(u107)
        let history = messages(of: request)
        XCTAssertEqual(history.count, 3)
        let folded = try XCTUnwrap(history[2]["content"] as? [[String: Any]])
        XCTAssertEqual(folded.map { $0["type"] as? String }, ["tool_result", "text"])
        XCTAssertEqual(folded[1]["text"] as? String, "did that work?")
        let v40 = await session.apiMessages.count
        XCTAssertEqual(v40, 4)
        let v41 = await session.messages.map(\.text)
        XCTAssertEqual(v41, ["skip", "Clearing it. ", "Cle", "did that work?", "Yes, it's gone."])

        // One stored row carries both the results and the text.
        let u108 = await session.conversation?.id
        let rows = try await store.messages(in: try XCTUnwrap(u108))
        let folds = rows.filter { $0.role == .user && $0.apiContent?.blocks != nil }
        XCTAssertEqual(folds.count, 1)
        XCTAssertEqual(folds[0].displayText, "did that work?")
        XCTAssertEqual(folds[0].apiContent?.blocks?.count, 2)
    }

    // MARK: - Errors → inline states

    func test402ProducesANoticeAndBlocksUntilAKeyIsAdded() async throws {
        let transport = ScriptedTransport([.status(402, body: "anthropic-key-missing")])
        let session = makeSession(transport)
        await session.send("hi")
        let v42 = await session.state
        XCTAssertEqual(v42, .blocked(.missingKey))
        let v43 = await session.messages.map(\.text)
        XCTAssertEqual(v43, ["hi", ChatCopy.keySetup])
        let v44 = await session.messages.last?.kind
        XCTAssertEqual(v44, .notice)
        let v45 = await session.apiMessages
        XCTAssertEqual(v45, [.user("hi")])
        let v46 = await session.canSend
        XCTAssertFalse(v46)
        await session.send("again")
        let v47 = await transport.count
        XCTAssertEqual(v47, 1)

        await session.keyAdded()
        let v48 = await session.state
        XCTAssertEqual(v48, .idle)
        let v49 = await session.canSend
        XCTAssertTrue(v49)
    }

    func test429BlocksUntilRetryAfterThenClears() async throws {
        let clock = TestClock(now: now)
        let transport = ScriptedTransport([.status(429, body: "Too many requests", headers: ["Retry-After": "600"])])
        let session = makeSession(transport, clock: clock)
        await session.send("hi")
        let v50 = await session.state
        XCTAssertEqual(v50, .blocked(.rateLimited(until: now.addingTimeInterval(600))))
        let v51 = await session.messages.last?.text
        XCTAssertEqual(v51, ChatCopy.rateLimited)
        let v52 = await session.canSend
        XCTAssertFalse(v52)

        clock.advance(by: 601)
        let v53 = await session.canSend
        XCTAssertTrue(v53)
        await transport.script([.ndjson(text("Back."))])
        await session.send("hi again")
        let v54 = await session.state
        XCTAssertEqual(v54, .idle)
        let v55 = await session.messages.last?.text
        XCTAssertEqual(v55, "Back.")
    }

    func testServerErrorProducesTheGenericNotice() async throws {
        let transport = ScriptedTransport([.status(500, body: "Failed to build coach context")])
        let session = makeSession(transport)
        await session.send("hi")
        let v56 = await session.state
        XCTAssertEqual(v56, .idle)
        let v57 = await session.messages.map(\.text)
        XCTAssertEqual(v57, ["hi", ChatCopy.genericFailure])
        let v58 = await session.apiMessages
        XCTAssertEqual(v58, [.user("hi")])
    }

    func testInBandErrorEventKeepsThePartialAndNotices() async throws {
        let transport = ScriptedTransport([.ndjson(text("Half", done: false) + [#"{"type":"error","message":"Chat request failed"}"#])])
        let session = makeSession(transport)
        await session.send("hi")
        let v59 = await session.state
        XCTAssertEqual(v59, .idle)
        let v60 = await session.messages.map(\.text)
        XCTAssertEqual(v60, ["hi", "Half", ChatCopy.genericFailure])
        let v61 = await session.messages.map(\.kind)
        XCTAssertEqual(v61, [.turn, .stopped, .notice])
        let v62 = await session.apiMessages
        XCTAssertEqual(v62, [.user("hi")])
    }

    func testEmptyTurnIsDroppedFromApiHistory() async throws {
        let transport = ScriptedTransport([.ndjson([#"{"type":"done"}"#])])
        let session = makeSession(transport)
        await session.send("hi")
        let v63 = await session.state
        XCTAssertEqual(v63, .idle)
        let v64 = await session.apiMessages
        XCTAssertEqual(v64, [.user("hi")])
        let v65 = await session.messages.last?.text
        XCTAssertEqual(v65, ChatCopy.emptyReply)
    }

    func testNetworkFailureIsTheGenericNoticeToo() async throws {
        let transport = ScriptedTransport([.throwNetwork])
        let session = makeSession(transport)
        await session.send("hi")
        let v66 = await session.state
        XCTAssertEqual(v66, .idle)
        let v67 = await session.messages.last?.text
        XCTAssertEqual(v67, ChatCopy.genericFailure)
    }

    // MARK: - Notes and conversations

    func testNotesCreatesANewConversationWithAHiddenPromptToolsOff() async throws {
        let store = MemoryConversationStore()
        let transport = ScriptedTransport([.ndjson(text("Hi.")), .ndjson(text("Today: squat."))])
        let session = makeSession(transport, store: store)

        await session.send("hi")
        let u109 = await session.conversation?.id
        let first = try XCTUnwrap(u109)
        await session.notes()

        let u110 = await session.conversation
        let notes = try XCTUnwrap(u110)
        XCTAssertNotEqual(notes.id, first)
        XCTAssertEqual(notes.title, "Coach's Notes · \(today)")
        let u111 = await transport.requests.last
        let request = try XCTUnwrap(u111)
        XCTAssertEqual(request.body?["withTools"] as? Bool, false)
        XCTAssertEqual(messages(of: request).count, 1)
        XCTAssertEqual(messages(of: request)[0]["content"] as? String, ChatCopy.notesPrompt)
        let v68 = await session.messages.map(\.text)
        XCTAssertEqual(v68, ["Today: squat."])
        let v69 = await session.apiMessages
        XCTAssertEqual(v69, [.user(ChatCopy.notesPrompt), .assistant("Today: squat.")])

        let v70 = try await store.conversations(mode: .chat).count
        XCTAssertEqual(v70, 2)
        let rows = try await store.messages(in: notes.id)
        XCTAssertNil(rows[0].displayText)
        XCTAssertEqual(rows[0].apiContent, .text(ChatCopy.notesPrompt))
    }

    func testNotesFailureUsesItsOwnCopy() async throws {
        let transport = ScriptedTransport([.status(500)])
        let session = makeSession(transport)
        await session.notes()
        let v71 = await session.messages.map(\.text)
        XCTAssertEqual(v71, [ChatCopy.notesFailure])
    }

    func testStartNewConversationKeepsAMissingKeyBlock() async throws {
        let transport = ScriptedTransport([.status(402, body: "anthropic-key-missing")])
        let session = makeSession(transport)
        await session.send("hi")
        await session.startNewConversation()
        let v72 = await session.state
        XCTAssertEqual(v72, .blocked(.missingKey))
        let v73 = await session.messages
        XCTAssertEqual(v73, [])
        let v74 = await session.conversation
        XCTAssertNil(v74)
    }

    func testRelaunchRederivesThePendingQueueFromTheTail() async throws {
        let store = MemoryConversationStore()
        let first = ScriptedTransport([.ndjson(try fixtureLines)])
        let before = makeSession(first, store: store)
        await before.send("skip next week")
        let u112 = await before.conversation?.id
        let id = try XCTUnwrap(u112)

        // A new session over the same store: the card comes back.
        let transport = ScriptedTransport([.ok(coachToolOK), .ndjson(text("Cleared."))])
        let session = makeSession(transport, store: store)
        await session.load(conversationId: id)

        guard case .awaitingConfirmation(let head, 1, 1) = await session.state else { return XCTFail("\(await session.state)") }
        XCTAssertEqual(head.displayLabel, fixtureLabel)
        let v75 = await session.messages.map(\.text)
        XCTAssertEqual(v75, ["skip next week", "Clearing it. "])
        let v76 = await session.conversation?.id
        XCTAssertEqual(v76, id)

        await session.confirmHead()
        let v77 = await session.state
        XCTAssertEqual(v77, .idle)
        let v78 = await transport.requests.map(\.path)
        XCTAssertEqual(v78, ["/api/coach-tool", "/api/chat"])
        let v79 = messages(of: await transport.requests[1]).count
        XCTAssertEqual(v79, 3)
    }

    func testRelaunchResumesAtTheNextUnsettledAction() async throws {
        let store = MemoryConversationStore()
        let stream = [toolUse("tu_1", label: "A"), toolUse("tu_2", label: "B"), toolUse("tu_3", label: "C"), #"{"type":"done"}"#]
        let first = ScriptedTransport([.ndjson(stream), .ok(#"{"ok":true,"resultText":"Done."}"#)])
        let before = makeSession(first, store: store)
        await before.send("clear")
        await before.confirmHead()
        guard case .awaitingConfirmation(_, 2, 3) = await before.state else { return XCTFail("\(await before.state)") }
        let u113 = await before.conversation?.id
        let id = try XCTUnwrap(u113)

        let transport = ScriptedTransport([.ok(#"{"ok":true,"resultText":"Done."}"#), .ndjson(text("All set."))])
        let session = makeSession(transport, store: store)
        await session.load(conversationId: id)
        guard case .awaitingConfirmation(let head, 2, 3) = await session.state else { return XCTFail("\(await session.state)") }
        XCTAssertEqual(head.displayLabel, "B")

        await session.cancelHead()
        await session.confirmHead()
        let v80 = await session.state
        XCTAssertEqual(v80, .idle)
        let r2 = await transport.requests[1]
        let flushed = try XCTUnwrap(messages(of: r2).last?["content"] as? [[String: Any]])
        XCTAssertEqual(flushed.map { $0["content"] as? String }, ["Done.", ChatCopy.cancelledByUser, "Done."])
        // user, assistant, ONE tool_result message, follow-up — no duplicate flush.
        let v81 = await session.apiMessages.map(\.role)
        XCTAssertEqual(v81, [.user, .assistant, .user, .assistant])
        let rows = try await store.messages(in: id)
        XCTAssertEqual(rows.filter { $0.role == .user && $0.apiContent?.blocks != nil }.count, 1)
    }

    func testLoadOfACompleteFlushWithoutAFollowUpIsIdleAndFolds() async throws {
        let store = MemoryConversationStore()
        let first = ScriptedTransport([.ndjson(try fixtureLines), .ok(coachToolOK), .status(500)])
        let before = makeSession(first, store: store)
        await before.send("skip")
        await before.confirmHead()
        let u114 = await before.conversation?.id
        let id = try XCTUnwrap(u114)

        let transport = ScriptedTransport([.ndjson(text("Yes."))])
        let session = makeSession(transport, store: store)
        await session.load(conversationId: id)
        let v82 = await session.state
        XCTAssertEqual(v82, .idle)
        await session.send("did it work?")
        let r3 = await transport.requests[0]
        let folded = try XCTUnwrap(messages(of: r3).last?["content"] as? [[String: Any]])
        XCTAssertEqual(folded.map { $0["type"] as? String }, ["tool_result", "text"])
    }

    func testHistoryWindowIsAppliedToTheRequest() async throws {
        let store = MemoryConversationStore()
        let conversation = Conversation(id: "long", mode: .chat, title: "long", createdAt: now, updatedAt: now)
        try await store.create(conversation)
        for i in 0..<70 {
            let role: ApiMessage.Role = i.isMultiple(of: 2) ? .user : .assistant
            try await store.append(StoredMessage(
                id: "m\(i)", conversationId: "long", role: role, apiContent: .text("t\(i)"), displayText: "t\(i)",
                kind: .turn, createdAt: now
            ))
        }
        let transport = ScriptedTransport([.ndjson(text("ok"))])
        let session = makeSession(transport, store: store)
        await session.load(conversationId: "long")
        let v83 = await session.apiMessages.count
        XCTAssertEqual(v83, 70)
        await session.send("one more")
        let u115 = await transport.requests.first
        let sent = messages(of: try XCTUnwrap(u115))
        XCTAssertLessThanOrEqual(sent.count, 60)
        XCTAssertEqual(sent.first?["role"] as? String, "user")
        XCTAssertEqual(sent.last?["content"] as? String, "one more")
        // Local history is untouched by the window.
        let v84 = await session.apiMessages.count
        XCTAssertEqual(v84, 72)
    }

    func testStoreLessSessionCarriesTheDraftContext() async throws {
        let transport = ScriptedTransport([.ndjson(text("Added squats."))])
        let session = makeSession(transport, store: nil, mode: .builder, draft: ["title": "Leg day"])
        await session.send("add squats")
        let u116 = await transport.requests.first
        let request = try XCTUnwrap(u116)
        XCTAssertEqual(request.body?["mode"] as? String, "builder")
        XCTAssertEqual(((request.body?["context"] as? [String: Any])?["draft"] as? [String: Any])?["title"] as? String, "Leg day")
        let v85 = await session.state
        XCTAssertEqual(v85, .idle)
        let v86 = await session.messages.map(\.text)
        XCTAssertEqual(v86, ["add squats", "Added squats."])
        let v87 = await session.conversation
        XCTAssertNotNil(v87)
    }

    /// The fixture bytes in 7-byte pieces through the real client: the line
    /// parser reassembles them and the session sees the same three events.
    func testChunkedNDJSONAcrossLineBoundaries() async throws {
        let whole = String(decoding: try TestFixtures.data("chat-stream.ndjson"), as: UTF8.self)
        var chunks: [String] = []
        var rest = Substring(whole)
        while !rest.isEmpty {
            let piece = rest.prefix(7)
            chunks.append(String(piece))
            rest = rest.dropFirst(7)
        }
        let transport = ScriptedTransport([.chunks(chunks)])
        let session = makeSession(transport)
        await session.send("skip next week")
        guard case .awaitingConfirmation(let head, 1, 1) = await session.state else { return XCTFail("\(await session.state)") }
        XCTAssertEqual(head.displayLabel, fixtureLabel)
        let v88 = await session.messages.last?.text
        XCTAssertEqual(v88, "Clearing it. ")
    }

    // MARK: - Builder mode (W7): the draft tool runs without a card

    private var builderLines: [String] {
        get throws {
            String(decoding: try TestFixtures.data("chat-stream-builder.ndjson"), as: UTF8.self)
                .split(separator: "\n").map(String.init)
        }
    }
    private let reducedOK = #"{"ok":true,"resultText":"Draft updated: exercises (1). The user reviews and presses Apply.","draft":{"title":"Leg day","lists":{"exercises":[{"id":"fx","name":"Fixture Press"}]}}}"#
    private let reducedDraft: JSONValue = ["title": "Leg day", "lists": ["exercises": [["id": "fx", "name": "Fixture Press"]]]]

    private func draftToolUse(_ id: String) -> String {
        #"{"type":"tool_use","id":"\#(id)","name":"update_workout_draft","input":{"exercises":[{"name":"fx press","sets":3,"reps":"8"}]}}"#
    }

    func testBuilderDraftToolAutoExecutesWithoutACardAndEmitsTheDraft() async throws {
        let transport = ScriptedTransport([.ndjson(try builderLines), .ok(reducedOK), .ndjson(text("Added it."))])
        let session = makeSession(transport, store: nil, mode: .builder, draft: ["title": "Leg day", "lists": ["exercises": []]])
        let events = Events()
        await events.start(await session.subscribe())

        await session.send("add fixture press 3x8")

        let v1 = await session.state
        XCTAssertEqual(v1, .idle)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat", "/api/coach-tool", "/api/chat"])
        let tool = requests[1]
        XCTAssertEqual(tool.body?["name"] as? String, "update_workout_draft")
        XCTAssertEqual(tool.body?["toolUseId"] as? String, "toolu_fixture_draft")
        XCTAssertEqual((tool.body?["draft"] as? [String: Any])?["title"] as? String, "Leg day")
        XCTAssertEqual(((tool.body?["draft"] as? [String: Any])?["lists"] as? [String: Any]).map { ($0["exercises"] as? [Any])?.count } ?? nil, 0)
        XCTAssertEqual(tool.body?["today"] as? String, today)

        // The reduced draft replaces the session's and rides on the follow-up.
        let v2 = await events.contains(.draft(reducedDraft))
        XCTAssertTrue(v2)
        let v3 = await session.config.draft
        XCTAssertEqual(v3, reducedDraft)
        let followUp = requests[2]
        XCTAssertEqual(followUp.body?["withTools"] as? Bool, false)
        XCTAssertEqual(followUp.body?["mode"] as? String, "builder")
        let sentDraft = (followUp.body?["context"] as? [String: Any])?["draft"] as? [String: Any]
        XCTAssertEqual(((sentDraft?["lists"] as? [String: Any])?["exercises"] as? [Any])?.count, 1)
        let history = messages(of: followUp)
        let results = try XCTUnwrap(history[2]["content"] as? [[String: Any]])
        XCTAssertEqual(results[0]["tool_use_id"] as? String, "toolu_fixture_draft")
        XCTAssertEqual(results[0]["content"] as? String, "Draft updated: exercises (1). The user reviews and presses Apply.")

        // Never a card, never a "mutation landed" refresh.
        let all = await events.all
        XCTAssertFalse(all.contains { if case .state(.awaitingConfirmation) = $0 { true } else { false } })
        XCTAssertTrue(all.contains { if case .state(.executing) = $0 { true } else { false } })
        XCTAssertFalse(all.contains(.mutationConfirmed))
        let v4 = await session.messages.map(\.text)
        XCTAssertEqual(v4, ["add fixture press 3x8", "Adding it. ", "Added it."])
        await events.stop()
    }

    func testBuilderReducerRefusalTextBecomesTheToolResultWithoutADraftEvent() async throws {
        let refusal = #"{"ok":false,"resultText":"Unilateral exercises need per-side counts. Fix and retry.","draft":{"title":"Leg day"}}"#
        let transport = ScriptedTransport([.ndjson(try builderLines), .ok(refusal), .ndjson(text("Say the side."))])
        let session = makeSession(transport, store: nil, mode: .builder, draft: ["title": "Leg day"])
        let events = Events()
        await events.start(await session.subscribe())
        await session.send("add pistols")
        let requests = await transport.requests
        let results = try XCTUnwrap(messages(of: requests[2])[2]["content"] as? [[String: Any]])
        XCTAssertEqual(results[0]["content"] as? String, "Unilateral exercises need per-side counts. Fix and retry.")
        let all = await events.all
        XCTAssertFalse(all.contains { if case .draft = $0 { true } else { false } })
        XCTAssertFalse(all.contains { if case .toast = $0 { true } else { false } })
        let v5 = await session.config.draft
        XCTAssertEqual(v5, ["title": "Leg day"])
        await events.stop()
    }

    func testBuilderAutoCancelsAnyOtherToolWithoutARequest() async throws {
        let lines = [#"{"type":"text","delta":"Sure."}"#, toolUse("toolu_x"), #"{"type":"done"}"#]
        let transport = ScriptedTransport([.ndjson(lines), .ndjson(text("Okay."))])
        let session = makeSession(transport, store: nil, mode: .builder, draft: ["title": "Leg day"])
        await session.send("delete it")
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat", "/api/chat"])
        let results = try XCTUnwrap(messages(of: requests[1])[2]["content"] as? [[String: Any]])
        XCTAssertEqual(results[0]["content"] as? String, ChatCopy.cancelledByUser)
        let v6 = await session.state
        XCTAssertEqual(v6, .idle)
    }

    func testBuilderTwoDraftUpdatesReduceOntoTheLatestDraftAndFlushOnce() async throws {
        let lines = [#"{"type":"text","delta":"Two steps."}"#, draftToolUse("d1"), draftToolUse("d2"), #"{"type":"done"}"#]
        let second = #"{"ok":true,"resultText":"Draft updated: title.","draft":{"title":"Leg day 2"}}"#
        let transport = ScriptedTransport([.ndjson(lines), .ok(reducedOK), .ok(second), .ndjson(text("Done."))])
        let session = makeSession(transport, store: nil, mode: .builder, draft: ["title": "Leg day"])
        await session.send("go")
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat", "/api/coach-tool", "/api/coach-tool", "/api/chat"])
        // The second reduce starts from the first reduce's output.
        XCTAssertEqual(((requests[2].body?["draft"] as? [String: Any])?["lists"] as? [String: Any]).map { ($0["exercises"] as? [Any])?.count } ?? nil, 1)
        let results = try XCTUnwrap(messages(of: requests[3])[2]["content"] as? [[String: Any]])
        XCTAssertEqual(results.map { $0["tool_use_id"] as? String }, ["d1", "d2"])
        let v7 = await session.config.draft
        XCTAssertEqual(v7, ["title": "Leg day 2"])
    }

    func testBuilderCoachToolFailureAndCapUseTheChatCopy() async throws {
        let transport = ScriptedTransport([.ndjson(try builderLines), .status(500, body: "boom"), .ndjson(text("Hm."))])
        let session = makeSession(transport, store: nil, mode: .builder, draft: ["title": "Leg day"])
        let events = Events()
        await events.start(await session.subscribe())
        await session.send("add it")
        let v8 = await events.contains(.toast(ChatCopy.applyFailed))
        XCTAssertTrue(v8)
        let requests = await transport.requests
        let results = try XCTUnwrap(messages(of: requests[2])[2]["content"] as? [[String: Any]])
        XCTAssertEqual(results[0]["content"] as? String, ChatCopy.executorFailed)
        await events.stop()

        let capped = ScriptedTransport([.ndjson(try builderLines), .status(429, body: "Daily AI mutation cap reached.", headers: ["Retry-After": "3600"]), .ndjson(text("Hm."))])
        let session2 = makeSession(capped, store: nil, mode: .builder, draft: ["title": "Leg day"])
        let events2 = Events()
        await events2.start(await session2.subscribe())
        await session2.send("add it")
        let v9 = await events2.contains(.toast(ChatCopy.aiCapReached))
        XCTAssertTrue(v9)
        await events2.stop()
    }

    /// The guard on `.chat`: the same tool name still gets a card there.
    func testChatModeStillPresentsACardForTheDraftTool() async throws {
        let transport = ScriptedTransport([.ndjson(try builderLines)])
        let session = makeSession(transport)
        await session.send("add it")
        let v10 = await session.state
        guard case .awaitingConfirmation(let head, 1, 1) = v10 else { return XCTFail("expected a card, got \(v10)") }
        XCTAssertEqual(head.toolName, "update_workout_draft")
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/chat"])
    }
}
