import XCTest
@testable import ApexCore

/// The vectors of src/lib/coach/__tests__/actionQueue.test.ts, copied verbatim,
/// plus the two functions local persistence added (D-013).
final class ActionQueueTests: XCTestCase {
    private let toolUses: [ToolUseBlock] = [
        ToolUseBlock(id: "tu_1", name: "delete_event", input: ["event_id": "a", "scope": "all"], label: "Delete: A"),
        ToolUseBlock(id: "tu_2", name: "delete_event", input: ["event_id": "b", "scope": "all"], label: "Delete: B"),
        ToolUseBlock(id: "tu_3", name: "not_a_real_tool", input: [:]),
    ]

    // MARK: toPendingActions

    func testMapsEveryToolUseBlockToAPendingActionInOrder() {
        let actions = ActionQueue.toPendingActions(toolUses)
        XCTAssertEqual(actions.map(\.toolUseId), ["tu_1", "tu_2", "tu_3"])
        XCTAssertEqual(actions[0].toolName, "delete_event")
        XCTAssertEqual(actions[0].input, ["event_id": "a", "scope": "all"])
    }

    func testLabelsViaTheServerLabelFallingBackToTheToolName() {
        let actions = ActionQueue.toPendingActions(toolUses)
        XCTAssertEqual(actions[0].displayLabel, "Delete: A")
        XCTAssertEqual(actions[2].displayLabel, "not_a_real_tool")
    }

    // MARK: settleHead

    func testHoldsResultsWhileActionsRemain() {
        let queue = ActionQueue.toPendingActions(toolUses)
        let step1 = ActionQueue.settleHead(queue: queue, results: [], resultText: "Done.")
        XCTAssertNil(step1.flushed)
        XCTAssertEqual(step1.queue.map(\.toolUseId), ["tu_2", "tu_3"])
        XCTAssertEqual(step1.results, [ToolResult(toolUseId: "tu_1", content: "Done.")])
    }

    func testFlushesOneToolResultPerToolUseInOrderWhenTheLastSettles() {
        var queue = ActionQueue.toPendingActions(toolUses)
        var results: [ToolResult] = []
        var flushed: [ToolResult]?
        for text in ["Done.", "Cancelled by user.", "Done."] {
            let next = ActionQueue.settleHead(queue: queue, results: results, resultText: text)
            flushed = next.flushed
            queue = next.queue
            results = next.results
        }
        XCTAssertEqual(flushed, [
            ToolResult(toolUseId: "tu_1", content: "Done."),
            ToolResult(toolUseId: "tu_2", content: "Cancelled by user."),
            ToolResult(toolUseId: "tu_3", content: "Done."),
        ])
        XCTAssertEqual(queue, [])
        XCTAssertEqual(results, [])
    }

    func testFlushesImmediatelyForASingleActionQueue() {
        let queue = ActionQueue.toPendingActions(toolUses)
        let single = ActionQueue.settleHead(queue: [queue[0]], results: [], resultText: "Done.")
        XCTAssertEqual(single.flushed, [ToolResult(toolUseId: "tu_1", content: "Done.")])
        XCTAssertEqual(single.queue, [])
    }

    func testIsANoOpOnAnEmptyQueue() {
        let settled = ActionQueue.settleHead(queue: [], results: [], resultText: "Done.")
        XCTAssertEqual(settled, SettledQueue(queue: [], results: [], flushed: nil))
    }

    // MARK: appendUserText

    private let toolResultMsg = ApiMessage.user(toolResults: [ToolResult(toolUseId: "tu_1", content: "Done.")])

    func testAppendsAPlainUserMessageInTheNormalCase() {
        let history: [ApiMessage] = [.user("hi"), .assistant("hello")]
        XCTAssertEqual(ActionQueue.appendUserText(history, "next"), history + [.user("next")])
    }

    func testFoldsTextIntoATrailingUnansweredToolResultMessageToolResultsFirst() {
        let history: [ApiMessage] = [
            .user("delete it"),
            ApiMessage(role: .assistant, content: .blocks([.toolUse(ToolUseBlock(id: "tu_1", name: "delete_event", input: [:]))])),
            toolResultMsg, // flush stream failed — no assistant reply followed
        ]
        let next = ActionQueue.appendUserText(history, "did that work?")
        XCTAssertEqual(next.count, 3)
        XCTAssertEqual(next[2], ApiMessage(role: .user, content: .blocks([
            .toolResult(ToolResult(toolUseId: "tu_1", content: "Done.")),
            .text("did that work?"),
        ])))
    }

    func testDoesNotMergeIntoATrailingStringUserMessage() {
        XCTAssertEqual(ActionQueue.appendUserText([.user("hi")], "again"), [.user("hi"), .user("again")])
    }

    func testHandlesAnEmptyHistory() {
        XCTAssertEqual(ActionQueue.appendUserText([], "first"), [.user("first")])
    }

    // MARK: assistantMessage (useChat.ts's construction, minus the empty-array bug)

    func testAssistantMessageIsAStringWhenPureText() {
        XCTAssertEqual(ActionQueue.assistantMessage(text: "hello", toolUses: []), .assistant("hello"))
    }

    func testAssistantMessageIsBlocksWhenToolUsesArePresent() {
        let message = ActionQueue.assistantMessage(text: "Clearing it. ", toolUses: [toolUses[0]])
        XCTAssertEqual(message, ApiMessage(role: .assistant, content: .blocks([.text("Clearing it. "), .toolUse(toolUses[0])])))
        let silent = ActionQueue.assistantMessage(text: "", toolUses: [toolUses[0]])
        XCTAssertEqual(silent?.content.blocks?.count, 1)
    }

    func testAssistantMessageIsNilWhenTheTurnProducedNothing() {
        XCTAssertNil(ActionQueue.assistantMessage(text: "", toolUses: []))
    }

    // MARK: pendingTail (relaunch mid-confirmation)

    private var assistantWithTools: ApiMessage {
        ApiMessage(role: .assistant, content: .blocks([.text("On it.")] + toolUses.map(ContentBlock.toolUse)))
    }

    func testPendingTailIsNilWithoutAToolUseTail() {
        XCTAssertNil(ActionQueue.pendingTail([]))
        XCTAssertNil(ActionQueue.pendingTail([.user("hi"), .assistant("hello")]))
        XCTAssertNil(ActionQueue.pendingTail([.user("hi"), .assistant("hello"), .user("more")]))
    }

    func testPendingTailUnsettled() {
        let tail = ActionQueue.pendingTail([.user("go"), assistantWithTools])
        XCTAssertEqual(tail, PendingTail(toolUses: toolUses, settled: []))
    }

    func testPendingTailPartiallySettled() {
        let settled = [ToolResult(toolUseId: "tu_1", content: "Done.")]
        let tail = ActionQueue.pendingTail([.user("go"), assistantWithTools, .user(toolResults: settled)])
        XCTAssertEqual(tail, PendingTail(toolUses: toolUses, settled: settled))
    }

    func testPendingTailFullySettledIsNil() {
        let all = toolUses.map { ToolResult(toolUseId: $0.id, content: "Done.") }
        XCTAssertNil(ActionQueue.pendingTail([.user("go"), assistantWithTools, .user(toolResults: all)]))
        // A folded message (results + text) is a sent turn, never pending.
        let folded = ApiMessage(role: .user, content: .blocks([.toolResult(all[0]), .text("hm")]))
        XCTAssertNil(ActionQueue.pendingTail([.user("go"), assistantWithTools, folded]))
    }

    // MARK: historyWindow

    private func alternating(_ count: Int) -> [ApiMessage] {
        (0..<count).map { $0.isMultiple(of: 2) ? .user("u\($0)") : .assistant("a\($0)") }
    }

    func testWindowUnderLimitsSendsEverything() {
        let history = alternating(10)
        XCTAssertEqual(ActionQueue.historyWindow(history), history)
    }

    func testWindowCutsAtAUserStringBoundaryOverTheMessageLimit() {
        let history = alternating(65)
        let window = ActionQueue.historyWindow(history, maxMessages: 60)
        XCTAssertLessThanOrEqual(window.count, 60)
        XCTAssertTrue(window[0].isUserText)
        XCTAssertEqual(window.last, history.last)
        XCTAssertEqual(window[0], .user("u6"))
    }

    func testWindowNeverSplitsAToolUseFromItsToolResult() {
        // …, user, assistant(tool_uses), user(tool_results), assistant, user, …
        var history: [ApiMessage] = alternating(6)
        history += [.user("go"), assistantWithTools, .user(toolResults: toolUses.map { ToolResult(toolUseId: $0.id, content: "Done.") }), .assistant("done")]
        history += alternating(4)
        // A budget that lands the naive cut inside the exchange.
        let window = ActionQueue.historyWindow(history, maxMessages: 6)
        // The naive 6-message suffix would open on the tool_result message;
        // the cut moves forward to the next plain user turn instead.
        XCTAssertTrue(window[0].isUserText)
        XCTAssertFalse(window.contains { !$0.toolResults.isEmpty })
        XCTAssertEqual(window.count, 4)
    }

    func testWindowByteBudgetCuts() {
        let big = String(repeating: "x", count: 1_000)
        let history: [ApiMessage] = [.user(big), .assistant(big), .user(big), .assistant(big), .user("small"), .assistant("ok")]
        let window = ActionQueue.historyWindow(history, maxBytes: 1_500)
        XCTAssertEqual(window, [.user("small"), .assistant("ok")])
    }

    func testWindowFallsBackToTheSmallestValidSuffix() {
        let big = String(repeating: "x", count: 1_000)
        // Nothing fits the budget; the last plain user turn onward is sent anyway.
        let history: [ApiMessage] = [.user(big), .assistant(big), .user(big), .assistant(big)]
        XCTAssertEqual(ActionQueue.historyWindow(history, maxBytes: 100), [.user(big), .assistant(big)])
    }
}
