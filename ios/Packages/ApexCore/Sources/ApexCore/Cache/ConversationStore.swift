import Foundation

/// Local coach conversations (D-013). Shaped like the future server table so
/// the later move is a sync, not a rewrite: `conversations(id, mode, title,
/// created_at, updated_at)` and `messages(id, conversation_id, role,
/// api_content_json, display_text, created_at)`. Two local additions: an
/// `owner` (the GRDB store scopes by it, as `tracker_ops` does — another
/// account on the same phone never sees these) and a `kind`, because a row
/// with no API content is either an inline notice or the text of a stopped
/// stream, and the thread renders those differently.

public struct Conversation: Sendable, Equatable, Identifiable, Codable {
    public let id: String
    public let mode: ChatMode
    public var title: String?
    public let createdAt: Date
    public var updatedAt: Date

    public init(id: String, mode: ChatMode, title: String?, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.mode = mode
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct StoredMessage: Sendable, Equatable, Identifiable, Codable {
    public enum Kind: String, Sendable, Codable {
        /// A real turn: `apiContent` is set and goes back to the model.
        case turn
        /// Display-only: an error or state message. `apiContent` is nil.
        case notice
        /// Display-only: what the coach had said when the user pressed Stop.
        case stopped
    }

    public let id: String
    public let conversationId: String
    public let role: ApiMessage.Role
    /// Nil for display-only rows — they never reach the model.
    public var apiContent: ApiMessage.Content?
    /// Nil for rows the thread hides (a tool_result turn, the Notes prompt).
    public var displayText: String?
    public var kind: Kind
    public let createdAt: Date

    public init(
        id: String, conversationId: String, role: ApiMessage.Role,
        apiContent: ApiMessage.Content?, displayText: String?, kind: Kind, createdAt: Date
    ) {
        self.id = id
        self.conversationId = conversationId
        self.role = role
        self.apiContent = apiContent
        self.displayText = displayText
        self.kind = kind
        self.createdAt = createdAt
    }

    /// The message as the API sees it, or nil for display-only rows.
    public var apiMessage: ApiMessage? {
        apiContent.map { ApiMessage(role: role, content: $0) }
    }
}

/// Implemented by `ApexPersistence` over GRDB; `MemoryConversationStore` in
/// tests and as the fallback when SQLite will not open. Messages are returned
/// in insertion order; conversations newest-updated first.
public protocol ConversationStore: Sendable {
    func conversations(mode: ChatMode) async throws -> [Conversation]
    func conversation(id: String) async throws -> Conversation?
    func create(_ conversation: Conversation) async throws
    func setTitle(id: String, title: String) async throws
    func touch(id: String, at date: Date) async throws
    /// Removes the conversation and every message in it.
    func delete(id: String) async throws
    func messages(in conversationId: String) async throws -> [StoredMessage]
    func append(_ message: StoredMessage) async throws
    /// Replaces the row with the same id (a tool_result turn grows one result
    /// at a time; a stopped follow-up's row gains the next user's text).
    func update(_ message: StoredMessage) async throws
    func deleteAll() async throws
}
