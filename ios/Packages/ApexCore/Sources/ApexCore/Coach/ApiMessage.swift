import Foundation

/// The message shapes `/api/chat` forwards verbatim to the Anthropic API
/// (src/lib/coach/actionQueue.ts `ApiMessage`). Kept byte-compatible with the
/// web on purpose: a user's content is a string or `[tool_result | text]`; an
/// assistant's is a string when the turn was pure text and `[text | tool_use]`
/// otherwise. Round-tripping everything as arrays would be a silent divergence.

/// A tool the coach asked to run. `label` is the server-built card text
/// (W5a); it is stored locally so a card survives a relaunch, and stripped by
/// `Endpoint.chat` before the block goes back to the model — the API rejects
/// unknown fields.
public struct ToolUseBlock: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let input: JSONValue
    public var label: String?

    public init(id: String, name: String, input: JSONValue, label: String? = nil) {
        self.id = id
        self.name = name
        self.input = input
        self.label = label
    }

    /// From the wire event, decoding the raw input bytes once. Nil when the
    /// input is not a JSON object — the server refuses those, so a card for
    /// one could never be confirmed.
    public init?(_ event: ChatWireEvent) {
        guard case .toolUse(let id, let name, let data, let label) = event,
              let input = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object = input
        else { return nil }
        self.init(id: id, name: name, input: input, label: label)
    }

    public func strippingLabel() -> ToolUseBlock {
        ToolUseBlock(id: id, name: name, input: input, label: nil)
    }
}

/// What the user turn after a tool_use assistant turn must open with: one per
/// tool_use, in order. `content` is the executor's text or "Cancelled by user.".
public struct ToolResult: Codable, Sendable, Equatable {
    public let toolUseId: String
    public let content: String

    public init(toolUseId: String, content: String) {
        self.toolUseId = toolUseId
        self.content = content
    }
}

public enum ContentBlock: Codable, Sendable, Equatable {
    case text(String)
    case toolUse(ToolUseBlock)
    case toolResult(ToolResult)

    private enum CodingKeys: String, CodingKey {
        case type, text, id, name, input, label
        case toolUseId = "tool_use_id"
        case content
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "text":
            self = .text(try container.decode(String.self, forKey: .text))
        case "tool_use":
            self = .toolUse(ToolUseBlock(
                id: try container.decode(String.self, forKey: .id),
                name: try container.decode(String.self, forKey: .name),
                input: try container.decode(JSONValue.self, forKey: .input),
                label: try container.decodeIfPresent(String.self, forKey: .label)
            ))
        case "tool_result":
            self = .toolResult(ToolResult(
                toolUseId: try container.decode(String.self, forKey: .toolUseId),
                content: try container.decode(String.self, forKey: .content)
            ))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "unknown content block type \"\(other)\""
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .toolUse(let block):
            try container.encode("tool_use", forKey: .type)
            try container.encode(block.id, forKey: .id)
            try container.encode(block.name, forKey: .name)
            try container.encode(block.input, forKey: .input)
            try container.encodeIfPresent(block.label, forKey: .label)
        case .toolResult(let result):
            try container.encode("tool_result", forKey: .type)
            try container.encode(result.toolUseId, forKey: .toolUseId)
            try container.encode(result.content, forKey: .content)
        }
    }

    public var isToolUse: Bool { if case .toolUse = self { return true } else { return false } }
    public var isToolResult: Bool { if case .toolResult = self { return true } else { return false } }
}

public struct ApiMessage: Codable, Sendable, Equatable {
    public enum Role: String, Codable, Sendable {
        case user
        case assistant
    }

    public enum Content: Codable, Sendable, Equatable {
        case text(String)
        case blocks([ContentBlock])

        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                self = .text(text)
            } else {
                self = .blocks(try container.decode([ContentBlock].self))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .text(let text): try container.encode(text)
            case .blocks(let blocks): try container.encode(blocks)
            }
        }

        public var blocks: [ContentBlock]? {
            if case .blocks(let blocks) = self { return blocks } else { return nil }
        }
    }

    public var role: Role
    public var content: Content

    public init(role: Role, content: Content) {
        self.role = role
        self.content = content
    }

    public static func user(_ text: String) -> ApiMessage { ApiMessage(role: .user, content: .text(text)) }
    public static func assistant(_ text: String) -> ApiMessage { ApiMessage(role: .assistant, content: .text(text)) }
    public static func user(toolResults: [ToolResult]) -> ApiMessage {
        ApiMessage(role: .user, content: .blocks(toolResults.map(ContentBlock.toolResult)))
    }

    /// A plain string user turn — the only place a history window may start.
    public var isUserText: Bool {
        if role == .user, case .text = content { return true }
        return false
    }

    /// The tool_use blocks of an assistant turn, in emission order.
    public var toolUses: [ToolUseBlock] {
        guard role == .assistant, let blocks = content.blocks else { return [] }
        return blocks.compactMap { if case .toolUse(let block) = $0 { return block } else { return nil } }
    }

    /// The tool_result blocks of a user turn, in order.
    public var toolResults: [ToolResult] {
        guard role == .user, let blocks = content.blocks else { return [] }
        return blocks.compactMap { if case .toolResult(let result) = $0 { return result } else { return nil } }
    }

    /// The same message with every `label` removed — what goes on the wire.
    public func strippingLabels() -> ApiMessage {
        guard case .blocks(let blocks) = content else { return self }
        let stripped = blocks.map { block -> ContentBlock in
            if case .toolUse(let use) = block { return .toolUse(use.strippingLabel()) }
            return block
        }
        return ApiMessage(role: role, content: .blocks(stripped))
    }
}
