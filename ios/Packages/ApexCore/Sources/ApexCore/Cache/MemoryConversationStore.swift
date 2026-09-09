import Foundation

/// In-memory `ConversationStore`: every session test runs against it, and the
/// app falls back to it when the SQLite file will not open.
public actor MemoryConversationStore: ConversationStore {
    private var conversationsById: [String: Conversation] = [:]
    private var messagesByConversation: [String: [StoredMessage]] = [:]

    public init() {}

    public func conversations(mode: ChatMode) async throws -> [Conversation] {
        conversationsById.values
            .filter { $0.mode == mode }
            .sorted { $0.updatedAt == $1.updatedAt ? $0.id > $1.id : $0.updatedAt > $1.updatedAt }
    }

    public func conversation(id: String) async throws -> Conversation? { conversationsById[id] }

    public func create(_ conversation: Conversation) async throws {
        conversationsById[conversation.id] = conversation
        messagesByConversation[conversation.id] = messagesByConversation[conversation.id] ?? []
    }

    public func setTitle(id: String, title: String) async throws {
        conversationsById[id]?.title = title
    }

    public func touch(id: String, at date: Date) async throws {
        conversationsById[id]?.updatedAt = date
    }

    public func delete(id: String) async throws {
        conversationsById[id] = nil
        messagesByConversation[id] = nil
    }

    public func messages(in conversationId: String) async throws -> [StoredMessage] {
        messagesByConversation[conversationId] ?? []
    }

    public func append(_ message: StoredMessage) async throws {
        messagesByConversation[message.conversationId, default: []].append(message)
    }

    public func update(_ message: StoredMessage) async throws {
        guard var rows = messagesByConversation[message.conversationId],
              let index = rows.firstIndex(where: { $0.id == message.id })
        else { return }
        rows[index] = message
        messagesByConversation[message.conversationId] = rows
    }

    public func deleteAll() async throws {
        conversationsById = [:]
        messagesByConversation = [:]
    }
}
