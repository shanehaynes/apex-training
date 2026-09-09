import ApexCore
import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/CoachSnapshotTests test
final class CoachSnapshotTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    private let markdown = """
    **Solid week.** Three sessions logged, one PR.

    ## Tomorrow
    - Fixture Push Day at 17:30 — aim for 115 lb on the press
    - Keep the run in zone 2

    1. Warm up ten minutes
    2. Two ramp sets before the first working set

    `est. 1RM 142 lb`
    """

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        ApexFonts.register()
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    @MainActor
    private func screen(_ model: CoachModel) -> some View {
        NavigationStack { CoachScreen(model: model) }
    }

    /// A conversation with a Markdown reply, opened by a fresh model.
    @MainActor
    private func threadModel(transport: CoachTransport = .healthy()) async -> CoachModel {
        transport.set("POST /api/chat tools", .ndjson(CoachTransport.text(markdown.replacingOccurrences(of: "\n", with: "\\n"))))
        let model = makeCoachModel(transport)
        await model.start()
        model.composerText = "How did this week go?"
        await model.send().value
        return model
    }

    @MainActor
    func testThreadWithMarkdown() async {
        let model = await threadModel()
        snapshot(screen(model), named: "thread-markdown")
        snapshot(screen(model), named: "thread-pro-max", size: CGSize(width: 440, height: 956))
        snapshot(screen(model), named: "thread-16e", size: CGSize(width: 390, height: 844))
        snapshot(screen(model).environment(\.sizeCategory, .extraExtraLarge), named: "thread-xxl")
    }

    @MainActor
    func testStreamingAndTyping() async {
        let transport = CoachTransport.healthy()
        transport.set("POST /api/chat tools", .ndjson([#"{"type":"text","delta":"Looking at your week — "}"#], holdOpen: true))
        let model = makeCoachModel(transport)
        await model.start()
        model.composerText = "How did this week go?"
        let sending = model.send()
        _ = await waitFor { model.partial.hasPrefix("Looking") }
        snapshot(screen(model), named: "thread-streaming")
        transport.release()
        await sending.value

        snapshot(CoachPreviews.typing(), named: "typing", size: CGSize(width: 200, height: 80))
    }

    @MainActor
    func testConfirmationCards() async {
        let model = makeCoachModel(CoachTransport.healthy())
        await model.start()
        model.composerText = "skip next week"
        await model.send().value
        snapshot(screen(model), named: "confirm-card")
        snapshot(CoachPreviews.card(label: "Create: Leg Day — Rebuild Phase 1 · 2026-08-06 17:30", index: 2, total: 3), named: "confirm-card-2-of-3", size: CGSize(width: 393, height: 240))
        snapshot(CoachPreviews.card(label: "Delete: Fixture Push Day · 2026-09-29 (this instance)", index: 1, total: 1, isBusy: true), named: "confirm-card-busy", size: CGSize(width: 393, height: 240))
    }

    @MainActor
    func testKeySetupAndNotices() async {
        let model = makeCoachModel(CoachTransport.healthy(hasKey: false))
        await model.start()
        snapshot(screen(model), named: "key-setup")

        let limited = CoachTransport.healthy()
        limited.set("POST /api/chat tools", .json(429, Data("Too many requests".utf8)))
        let rateLimited = makeCoachModel(limited)
        await rateLimited.start()
        rateLimited.composerText = "hi"
        await rateLimited.send().value
        snapshot(screen(rateLimited), named: "rate-limited")

        let stopped = ChatSession.DisplayMessage(id: "s", role: .assistant, text: "Looking at your week — three sessions", kind: .stopped)
        snapshot(CoachPreviews.bubble(stopped), named: "bubble-stopped", size: CGSize(width: 393, height: 120))
    }

    @MainActor
    func testConversationList() async {
        let store = MemoryConversationStore()
        let model = makeCoachModel(CoachTransport.healthy(), store: store)
        await model.start()
        model.composerText = "How did this week go?"
        await model.send().value
        await model.notes().value
        snapshot(ConversationListView(model: model), named: "conversation-list", size: CGSize(width: 393, height: 500))
    }

    @MainActor
    func testKeySheet() {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: CoachTransport.healthy(), tokens: CoachTestTokens())
        snapshot(AnthropicKeyView(client: client, hasKey: false, last4: nil) { _ in }, named: "key-sheet", size: CGSize(width: 393, height: 520))
        snapshot(AnthropicKeyView(client: client, hasKey: true, last4: "wxyz") { _ in }, named: "key-sheet-saved", size: CGSize(width: 393, height: 520))
    }
}
