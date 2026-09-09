import ApexCore
import XCTest
import ApexFeatures

/// The Coach tab's model over the scripted transport and an in-memory store:
/// the key states, a full turn with a card, the latch, Stop, Notes, resume,
/// delete, and the rate-limit block. The loop's own rules are proved in
/// `ApexCore`'s `ChatSessionTests`; this covers the UI-facing mirror.
final class CoachModelTests: XCTestCase {
    @MainActor
    func testStartWithoutAKeyShowsTheKeySetupState() async {
        let model = makeCoachModel(CoachTransport.healthy(hasKey: false))
        await model.start()
        XCTAssertTrue(model.needsKey)
        XCTAssertEqual(model.composerPlaceholder, ChatCopy.placeholderNeedsKey)
        XCTAssertEqual(model.modelLabel, "Opus 4.8")
        XCTAssertFalse(model.canStartTurn)
    }

    @MainActor
    func testStartWithAKeyOpensAnEmptyThreadWithTheModelLabel() async {
        let transport = CoachTransport.healthy()
        transport.set("GET /api/profile", .json(200, CoachTransport.profile(hasKey: true, model: "claude-sonnet-5")))
        let model = makeCoachModel(transport)
        await model.start()
        XCTAssertFalse(model.needsKey)
        XCTAssertEqual(model.modelLabel, "Sonnet 5")
        XCTAssertEqual(model.messages, [])
        XCTAssertEqual(model.state, .idle)
        XCTAssertTrue(model.canStartTurn)

        model.composerText = "skip next week"
        await model.send().value
        // The picked model rides on the request.
        XCTAssertEqual(transport.requests("/api/chat").first?.body?["model"] as? String, "claude-sonnet-5")
    }

    @MainActor
    func testSendRendersTheStreamThenTheCard() async {
        let store = MemoryConversationStore()
        let model = makeCoachModel(CoachTransport.healthy(), store: store)
        await model.start()
        model.composerText = "  skip next week \n"
        XCTAssertTrue(model.canSend)
        await model.send().value

        XCTAssertEqual(model.composerText, "")
        XCTAssertEqual(model.messages.map(\.text), ["skip next week", "Clearing it. "])
        XCTAssertEqual(model.pending?.action.displayLabel, "Delete: Fixture Push Day · 2026-09-29 (this instance)")
        XCTAssertEqual(model.pending?.index, 1)
        XCTAssertEqual(model.pending?.total, 1)
        XCTAssertEqual(model.composerPlaceholder, ChatCopy.placeholderPending)
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(model.conversations.count, 1)
        XCTAssertEqual(model.conversations.first?.title, "skip next week")
        XCTAssertEqual(model.conversation?.id, model.conversations.first?.id)
    }

    @MainActor
    func testConfirmFiresTheHapticTheRefreshHookAndTheFollowUp() async {
        var refreshes = 0
        let transport = CoachTransport.healthy()
        let model = makeCoachModel(transport, onMutation: { refreshes += 1 })
        await model.start()
        model.composerText = "skip next week"
        await model.send().value

        await model.confirm().value
        XCTAssertEqual(model.confirmCount, 1)
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(model.state, .idle)
        XCTAssertNil(model.pending)
        XCTAssertFalse(model.isActionLatched)
        XCTAssertEqual(model.messages.last?.text, "Done — cleared.")
        XCTAssertEqual(transport.requests("/api/coach-tool").count, 1)
        XCTAssertEqual(transport.requests("/api/chat").count, 2)
    }

    @MainActor
    func testCancelExecutesNothingAndRefreshesNothing() async {
        var refreshes = 0
        let transport = CoachTransport.healthy()
        let model = makeCoachModel(transport, onMutation: { refreshes += 1 })
        await model.start()
        model.composerText = "skip next week"
        await model.send().value
        await model.cancel().value
        XCTAssertEqual(refreshes, 0)
        XCTAssertEqual(model.confirmCount, 0)
        XCTAssertEqual(transport.requests("/api/coach-tool").count, 0)
        XCTAssertEqual(model.state, .idle)
    }

    @MainActor
    func testTheLatchBlocksASecondConfirm() async {
        let transport = CoachTransport.healthy()
        let model = makeCoachModel(transport)
        await model.start()
        model.composerText = "skip next week"
        await model.send().value
        let first = model.confirm()
        let second = model.confirm()
        XCTAssertTrue(model.isActionLatched)
        await first.value
        await second.value
        XCTAssertEqual(transport.requests("/api/coach-tool").count, 1)
        XCTAssertEqual(model.confirmCount, 1)
    }

    @MainActor
    func testStopKeepsThePartialAndReleasesTheComposer() async {
        let transport = CoachTransport.healthy()
        transport.set("POST /api/chat tools", .ndjson([#"{"type":"text","delta":"Clearing "}"#], holdOpen: true))
        let model = makeCoachModel(transport)
        await model.start()
        model.composerText = "skip"
        let sending = model.send()
        let w1 = await waitFor { model.partial == "Clearing " }
        XCTAssertTrue(w1)
        XCTAssertTrue(model.isStreaming)
        model.stop()
        await sending.value
        XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(model.partial, "")
        XCTAssertEqual(model.messages.last?.kind, .stopped)
        XCTAssertEqual(model.messages.last?.text, "Clearing ")
        let w2 = await waitFor { transport.cancellations == 1 }
        XCTAssertTrue(w2)
        model.composerText = "again"
        XCTAssertTrue(model.canSend)
    }

    @MainActor
    func testNotesStartsANewConversationAndKeepsTheOldOne() async {
        let store = MemoryConversationStore()
        let transport = CoachTransport.healthy()
        transport.set("POST /api/chat tools", .ndjson(CoachTransport.text("Hello.")))
        let model = makeCoachModel(transport, store: store)
        await model.start()
        model.composerText = "hi"
        await model.send().value
        let first = model.conversation?.id
        await model.notes().value
        XCTAssertNotEqual(model.conversation?.id, first)
        XCTAssertEqual(model.conversation?.title, "Coach's Notes · 2026-09-08")
        XCTAssertEqual(model.conversations.count, 2)
        XCTAssertEqual(model.messages.map(\.role), [.assistant])
    }

    @MainActor
    func testResumeOnRelaunchRederivesTheCard() async {
        let store = MemoryConversationStore()
        let before = makeCoachModel(CoachTransport.healthy(), store: store)
        await before.start()
        before.composerText = "skip next week"
        await before.send().value
        XCTAssertNotNil(before.pending)

        // A fresh model over the same store opens the latest conversation.
        let again = makeCoachModel(CoachTransport.healthy(), store: store)
        await again.start()
        XCTAssertEqual(again.conversation?.id, before.conversation?.id)
        XCTAssertEqual(again.messages.map(\.text), ["skip next week", "Clearing it. "])
        XCTAssertEqual(again.pending?.action.displayLabel, "Delete: Fixture Push Day · 2026-09-29 (this instance)")
        await again.confirm().value
        XCTAssertEqual(again.state, .idle)
    }

    @MainActor
    func testDeleteRemovesTheConversationAndStartsFreshWhenItWasOpen() async {
        let store = MemoryConversationStore()
        let model = makeCoachModel(CoachTransport.healthy(), store: store)
        await model.start()
        model.composerText = "hi"
        await model.send().value
        let id = model.conversation!.id
        await model.delete(id).value
        XCTAssertEqual(model.conversations, [])
        XCTAssertNil(model.conversation)
        XCTAssertEqual(model.messages, [])
        let rows = try? await store.messages(in: id)
        XCTAssertEqual(rows, [])
    }

    @MainActor
    func testKeyChangedUnblocksTheThread() async {
        let transport = CoachTransport.healthy(hasKey: false)
        transport.set("POST /api/chat tools", .json(402, Data("anthropic-key-missing".utf8)))
        let model = makeCoachModel(transport)
        await model.start()
        XCTAssertTrue(model.needsKey)

        // The key lands: the profile now says so and the server would answer.
        transport.set("GET /api/profile", .json(200, CoachTransport.profile(hasKey: true)))
        transport.set("POST /api/chat tools", .ndjson(CoachTransport.text("Hello.")))
        await model.keyChanged(ProfileResponse(hasAnthropicKey: true, anthropicKeyLast4: "wxyz", termsAccepted: nil, termsCurrent: true))
        XCTAssertFalse(model.needsKey)
        XCTAssertFalse(model.showKeySheet)
        XCTAssertEqual(model.profile?.anthropicKeyLast4, "abcd")
        model.composerText = "hi"
        await model.send().value
        XCTAssertEqual(model.messages.last?.text, "Hello.")
    }

    @MainActor
    func testA402MidThreadBlocksUntilTheKeyIsAdded() async {
        let transport = CoachTransport.healthy()
        transport.set("POST /api/chat tools", .json(402, Data("anthropic-key-missing".utf8)))
        let model = makeCoachModel(transport)
        await model.start()
        model.composerText = "hi"
        await model.send().value
        XCTAssertEqual(model.state, .blocked(.missingKey))
        XCTAssertTrue(model.needsKey)
        XCTAssertEqual(model.messages.last?.text, ChatCopy.keySetup)
        await model.keyChanged(nil)
        XCTAssertEqual(model.state, .idle)
    }

    @MainActor
    func testRateLimitedDisablesTheComposerUntilRetryAfter() async {
        let transport = CoachTransport.healthy()
        transport.set("POST /api/chat tools", .json(429, Data("Too many requests".utf8)))
        let clock = TestClock(now: coachTestNow)
        let model = makeCoachModel(transport, clock: clock)
        await model.start()
        model.composerText = "hi"
        await model.send().value
        XCTAssertNotNil(model.rateLimitedUntil)
        model.composerText = "again"
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(model.messages.last?.text, ChatCopy.rateLimited)
        clock.advance(by: 601)
        XCTAssertNil(model.rateLimitedUntil)
        XCTAssertTrue(model.canSend)
    }

    @MainActor
    func testToolFailureToasts() async {
        let transport = CoachTransport.healthy()
        transport.set("POST /api/coach-tool", status: 500, body: "Tool execution failed")
        let model = makeCoachModel(transport)
        await model.start()
        model.composerText = "skip next week"
        await model.send().value
        await model.confirm().value
        XCTAssertEqual(model.state, .idle)
        let w3 = await waitFor { ToastBusProbe.hasToast(ChatCopy.applyFailed) }
        XCTAssertTrue(w3)
    }
}

import ApexUI
enum ToastBusProbe {
    @MainActor static func hasToast(_ text: String) -> Bool { ToastBus.shared.toasts.contains { $0.message == text } }
}
