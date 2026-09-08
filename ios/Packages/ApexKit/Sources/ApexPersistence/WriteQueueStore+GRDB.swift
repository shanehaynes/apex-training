import ApexCore
import Foundation
import GRDB

/// `ApexCore.WriteQueueStore` over the `tracker_ops` table, scoped to one owner.
/// Every query filters on `owner`, so a second account on the same phone never
/// sees — or flushes — the first one's unsynced workout.
public struct GRDBWriteQueueStore: WriteQueueStore {
    private let pool: DatabasePool
    private let owner: String

    public init(pool: DatabasePool, owner: String) {
        self.pool = pool
        self.owner = owner
    }

    public func append(_ op: TrackerOp) async throws -> Int64 {
        let payload = try JSONEncoder().encode(op.payload)
        return try await pool.write { [owner] db in
            try db.execute(
                sql: """
                INSERT INTO tracker_ops (owner, event_id, event_date, action, payload, created_at, attempts, last_error, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [
                    owner, op.session.eventId, op.session.eventDate, op.payload.action.rawValue, payload,
                    op.createdAt.timeIntervalSince1970, op.attempts, op.lastError, op.state.rawValue,
                ]
            )
            return db.lastInsertedRowID
        }
    }

    public func update(_ op: TrackerOp) async throws {
        let payload = try JSONEncoder().encode(op.payload)
        try await pool.write { [owner] db in
            try db.execute(
                sql: """
                UPDATE tracker_ops SET action = ?, payload = ?, attempts = ?, last_error = ?, state = ?
                WHERE id = ? AND owner = ?
                """,
                arguments: [op.payload.action.rawValue, payload, op.attempts, op.lastError, op.state.rawValue, op.id, owner]
            )
        }
    }

    public func delete(id: Int64) async throws {
        try await pool.write { [owner] db in
            try db.execute(sql: "DELETE FROM tracker_ops WHERE id = ? AND owner = ?", arguments: [id, owner])
        }
    }

    public func tail(for session: SessionKey) async throws -> TrackerOp? {
        try await pool.read { [owner] db in
            try Row.fetchOne(
                db,
                sql: "SELECT * FROM tracker_ops WHERE owner = ? AND event_id = ? AND event_date = ? ORDER BY id DESC LIMIT 1",
                arguments: [owner, session.eventId, session.eventDate]
            ).flatMap(Self.op)
        }
    }

    public func nextPending(for session: SessionKey) async throws -> TrackerOp? {
        try await pool.read { [owner] db in
            try Row.fetchOne(
                db,
                sql: "SELECT * FROM tracker_ops WHERE owner = ? AND event_id = ? AND event_date = ? AND state = 'pending' ORDER BY id ASC LIMIT 1",
                arguments: [owner, session.eventId, session.eventDate]
            ).flatMap(Self.op)
        }
    }

    public func ops(for session: SessionKey) async throws -> [TrackerOp] {
        try await pool.read { [owner] db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM tracker_ops WHERE owner = ? AND event_id = ? AND event_date = ? ORDER BY id ASC",
                arguments: [owner, session.eventId, session.eventDate]
            ).compactMap(Self.op)
        }
    }

    public func sessionsWithPending() async throws -> [SessionKey] {
        try await pool.read { [owner] db in
            try Row.fetchAll(
                db,
                sql: "SELECT event_id, event_date, MIN(id) AS first FROM tracker_ops WHERE owner = ? AND state = 'pending' GROUP BY event_id, event_date ORDER BY first ASC",
                arguments: [owner]
            ).map { SessionKey(eventId: $0["event_id"], eventDate: $0["event_date"]) }
        }
    }

    public func purge(session: SessionKey) async throws {
        try await pool.write { [owner] db in
            try db.execute(
                sql: "DELETE FROM tracker_ops WHERE owner = ? AND event_id = ? AND event_date = ?",
                arguments: [owner, session.eventId, session.eventDate]
            )
        }
    }

    public func purgeAll() async throws {
        try await pool.write { [owner] db in
            try db.execute(sql: "DELETE FROM tracker_ops WHERE owner = ?", arguments: [owner])
        }
    }

    /// A row whose payload no longer decodes (an op shape this build has
    /// dropped) is skipped rather than crashing the queue.
    private static func op(_ row: Row) -> TrackerOp? {
        guard let payload = try? JSONDecoder().decode(TrackerOpPayload.self, from: row["payload"] as Data),
              let state = TrackerOpState(rawValue: row["state"]) else { return nil }
        return TrackerOp(
            id: row["id"],
            session: SessionKey(eventId: row["event_id"], eventDate: row["event_date"]),
            payload: payload,
            createdAt: Date(timeIntervalSince1970: row["created_at"]),
            attempts: row["attempts"],
            lastError: row["last_error"],
            state: state
        )
    }
}
