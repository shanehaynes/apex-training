import ApexCore
import Foundation
import GRDB

/// `ApexCore.ConversationStore` over `conversations` / `messages`, scoped to one
/// owner: another account on the same phone never lists or resumes these.
/// Messages come back in insertion order (`created_at`, then `rowid` for rows
/// stamped in the same instant by a test clock).
public struct GRDBConversationStore: ConversationStore {
    private let pool: DatabasePool
    private let owner: String

    public init(pool: DatabasePool, owner: String) {
        self.pool = pool
        self.owner = owner
    }

    public func conversations(mode: ChatMode) async throws -> [Conversation] {
        try await pool.read { [owner] db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM conversations WHERE owner = ? AND mode = ? ORDER BY updated_at DESC, rowid DESC",
                arguments: [owner, mode.rawValue]
            ).compactMap(Self.conversation)
        }
    }

    public func conversation(id: String) async throws -> Conversation? {
        try await pool.read { [owner] db in
            try Row.fetchOne(db, sql: "SELECT * FROM conversations WHERE id = ? AND owner = ?", arguments: [id, owner])
                .flatMap(Self.conversation)
        }
    }

    public func create(_ conversation: Conversation) async throws {
        try await pool.write { [owner] db in
            try db.execute(
                sql: "INSERT OR REPLACE INTO conversations (id, owner, mode, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                arguments: [
                    conversation.id, owner, conversation.mode.rawValue, conversation.title,
                    conversation.createdAt.timeIntervalSince1970, conversation.updatedAt.timeIntervalSince1970,
                ]
            )
        }
    }

    public func setTitle(id: String, title: String) async throws {
        try await pool.write { [owner] db in
            try db.execute(sql: "UPDATE conversations SET title = ? WHERE id = ? AND owner = ?", arguments: [title, id, owner])
        }
    }

    public func touch(id: String, at date: Date) async throws {
        try await pool.write { [owner] db in
            try db.execute(
                sql: "UPDATE conversations SET updated_at = ? WHERE id = ? AND owner = ?",
                arguments: [date.timeIntervalSince1970, id, owner]
            )
        }
    }

    public func delete(id: String) async throws {
        try await pool.write { [owner] db in
            // The FK cascade needs foreign keys on; GRDB enables them by default,
            // but the explicit delete keeps the contract even if that changes.
            try db.execute(sql: "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id = ? AND owner = ?)", arguments: [id, owner])
            try db.execute(sql: "DELETE FROM conversations WHERE id = ? AND owner = ?", arguments: [id, owner])
        }
    }

    public func messages(in conversationId: String) async throws -> [StoredMessage] {
        try await pool.read { [owner] db in
            try Row.fetchAll(
                db,
                sql: """
                SELECT m.* FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE m.conversation_id = ? AND c.owner = ?
                ORDER BY m.created_at ASC, m.rowid ASC
                """,
                arguments: [conversationId, owner]
            ).compactMap(Self.message)
        }
    }

    public func append(_ message: StoredMessage) async throws {
        let api = try message.apiContent.map { try JSONEncoder().encode($0) }
        try await pool.write { db in
            try db.execute(
                sql: "INSERT INTO messages (id, conversation_id, role, api_content_json, display_text, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                arguments: [
                    message.id, message.conversationId, message.role.rawValue, api, message.displayText,
                    message.kind.rawValue, message.createdAt.timeIntervalSince1970,
                ]
            )
        }
    }

    public func update(_ message: StoredMessage) async throws {
        let api = try message.apiContent.map { try JSONEncoder().encode($0) }
        try await pool.write { db in
            try db.execute(
                sql: "UPDATE messages SET api_content_json = ?, display_text = ?, kind = ? WHERE id = ? AND conversation_id = ?",
                arguments: [api, message.displayText, message.kind.rawValue, message.id, message.conversationId]
            )
        }
    }

    public func deleteAll() async throws {
        try await pool.write { [owner] db in
            try db.execute(sql: "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE owner = ?)", arguments: [owner])
            try db.execute(sql: "DELETE FROM conversations WHERE owner = ?", arguments: [owner])
        }
    }

    private static func conversation(_ row: Row) -> Conversation? {
        guard let mode = ChatMode(rawValue: row["mode"]) else { return nil }
        return Conversation(
            id: row["id"], mode: mode, title: row["title"],
            createdAt: Date(timeIntervalSince1970: row["created_at"]),
            updatedAt: Date(timeIntervalSince1970: row["updated_at"])
        )
    }

    /// A row whose API content no longer decodes is kept as display-only rather
    /// than dropped: the user still sees what was said, the model does not.
    private static func message(_ row: Row) -> StoredMessage? {
        guard let role = ApiMessage.Role(rawValue: row["role"]) else { return nil }
        let kind = StoredMessage.Kind(rawValue: row["kind"]) ?? .turn
        let api = (row["api_content_json"] as Data?).flatMap { try? JSONDecoder().decode(ApiMessage.Content.self, from: $0) }
        return StoredMessage(
            id: row["id"], conversationId: row["conversation_id"], role: role,
            apiContent: api, displayText: row["display_text"], kind: api == nil && kind == .turn ? .notice : kind,
            createdAt: Date(timeIntervalSince1970: row["created_at"])
        )
    }
}
