import Foundation

/// The pending-action queue for parallel tool calls — a port of
/// src/lib/coach/actionQueue.ts, with its test vectors copied into
/// `ActionQueueTests`. When a response carries several tool_use blocks, each
/// becomes a `PendingAction` the user confirms or cancels one at a time; the
/// API requires the NEXT user message to open with a tool_result for EVERY
/// tool_use in the assistant turn, so results accumulate and flush as one
/// message only after the last action settles.
///
/// Two additions the web never needed, both consequences of local persistence
/// (D-013): `pendingTail` re-derives the queue from a stored history on
/// relaunch, and `historyWindow` keeps a long thread under the server's caps.

public struct PendingAction: Sendable, Equatable, Identifiable {
    public let toolUseId: String
    public let toolName: String
    public let input: JSONValue
    /// The one-liner on the confirmation card. Server-built (`label` on the
    /// wire event); the tool name when the server sent none.
    public let displayLabel: String

    public var id: String { toolUseId }

    public init(toolUseId: String, toolName: String, input: JSONValue, displayLabel: String) {
        self.toolUseId = toolUseId
        self.toolName = toolName
        self.input = input
        self.displayLabel = displayLabel
    }
}

public struct SettledQueue: Sendable, Equatable {
    /// Actions still awaiting the user's confirm/cancel.
    public let queue: [PendingAction]
    /// Results held back until the whole queue settles.
    public let results: [ToolResult]
    /// Non-nil once every action has settled: the complete tool_result set,
    /// one per original tool_use, ready to send as a single user message.
    public let flushed: [ToolResult]?
}

/// A stored history that ends mid-confirmation: the assistant's tool_uses
/// and however many of them were already settled before the app went away.
public struct PendingTail: Sendable, Equatable {
    public let toolUses: [ToolUseBlock]
    public let settled: [ToolResult]
}

public enum ActionQueue {
    /// Append a user text message. If the history ends with an unanswered
    /// tool_result message (the post-confirm stream failed or was stopped
    /// before the coach replied), fold the text into that message instead —
    /// tool_result blocks must open the user turn that follows a tool_use
    /// assistant turn. A trailing *string* user message is never merged into.
    public static func appendUserText(_ messages: [ApiMessage], _ text: String) -> [ApiMessage] {
        if let last = messages.last, last.role == .user, case .blocks(let blocks) = last.content {
            var merged = messages
            merged[merged.count - 1] = ApiMessage(role: .user, content: .blocks(blocks + [.text(text)]))
            return merged
        }
        return messages + [.user(text)]
    }

    /// One PendingAction per tool_use block, in the order the model emitted them.
    public static func toPendingActions(_ toolUses: [ToolUseBlock]) -> [PendingAction] {
        toolUses.map {
            PendingAction(toolUseId: $0.id, toolName: $0.name, input: $0.input, displayLabel: $0.label ?? $0.name)
        }
    }

    /// Settle the head of the queue with its tool_result text. Returns the
    /// advanced queue; when the last action settles, `flushed` carries every
    /// result and the held state resets.
    public static func settleHead(queue: [PendingAction], results: [ToolResult], resultText: String) -> SettledQueue {
        guard let head = queue.first else { return SettledQueue(queue: queue, results: results, flushed: nil) }
        let rest = Array(queue.dropFirst())
        let next = results + [ToolResult(toolUseId: head.toolUseId, content: resultText)]
        return rest.isEmpty
            ? SettledQueue(queue: [], results: [], flushed: next)
            : SettledQueue(queue: rest, results: next, flushed: nil)
    }

    /// The assistant turn as the API stores it: a string for pure text, blocks
    /// when any tool_use is present, nil when the stream produced nothing at
    /// all (the web keeps an empty array there, which the next call rejects).
    public static func assistantMessage(text: String, toolUses: [ToolUseBlock]) -> ApiMessage? {
        if toolUses.isEmpty {
            return text.isEmpty ? nil : .assistant(text)
        }
        var blocks: [ContentBlock] = []
        if !text.isEmpty { blocks.append(.text(text)) }
        blocks.append(contentsOf: toolUses.map(ContentBlock.toolUse))
        return ApiMessage(role: .assistant, content: .blocks(blocks))
    }

    /// What a stored history is waiting on, if anything. Two shapes count: an
    /// assistant turn with tool_uses and nothing after it, or that turn
    /// followed by a user message made only of tool_results that covers fewer
    /// tool_uses than were emitted. A complete tool_result message is *not*
    /// pending — the follow-up simply never came, and `appendUserText` folds
    /// the next send into it, as on the web.
    public static func pendingTail(_ messages: [ApiMessage]) -> PendingTail? {
        guard let last = messages.last else { return nil }
        if last.role == .assistant {
            let uses = last.toolUses
            return uses.isEmpty ? nil : PendingTail(toolUses: uses, settled: [])
        }
        guard last.role == .user, let blocks = last.content.blocks, !blocks.isEmpty,
              blocks.allSatisfy(\.isToolResult),
              messages.count >= 2
        else { return nil }
        let previous = messages[messages.count - 2]
        let uses = previous.toolUses
        let settled = last.toolResults
        guard previous.role == .assistant, !uses.isEmpty, settled.count < uses.count else { return nil }
        return PendingTail(toolUses: uses, settled: settled)
    }

    /// The newest messages that fit under the server's caps (80 messages /
    /// 400 KB of serialised `messages` → 413), cut so the window opens on a
    /// plain user turn: a tool_use is never separated from its tool_result,
    /// and the model never sees a conversation that starts mid-exchange.
    /// If no such boundary fits, the smallest valid suffix is sent and the
    /// server has the last word.
    public static func historyWindow(
        _ messages: [ApiMessage], maxMessages: Int = 60, maxBytes: Int = 300_000
    ) -> [ApiMessage] {
        guard !messages.isEmpty else { return [] }
        var start = messages.count
        var bytes = 0
        while start > 0 {
            let size = encodedSize(messages[start - 1])
            if messages.count - start + 1 > maxMessages || bytes + size > maxBytes { break }
            bytes += size
            start -= 1
        }
        if let cut = messages[start...].firstIndex(where: \.isUserText) {
            return Array(messages[cut...])
        }
        if let last = messages.lastIndex(where: \.isUserText) {
            return Array(messages[last...])
        }
        return messages
    }

    private static func encodedSize(_ message: ApiMessage) -> Int {
        (try? JSONEncoder().encode(message.strippingLabels()).count) ?? 0
    }
}
