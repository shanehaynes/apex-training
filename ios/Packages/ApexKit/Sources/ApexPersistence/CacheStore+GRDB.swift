import ApexCore
import Foundation
import GRDB

/// Whose rows the cache reads and writes.
///
/// `GRDBWriteQueueStore` takes its owner as a plain `String` because the queue
/// is built in `AppModel.ensureQueue`, once the signed-in user is known. The
/// cache cannot be: the presenters that read it (`schedule`, `analytics`) are
/// assembled in `AppModel.init`, before the stored session has been restored,
/// and swapping those presenters later would strand the SwiftUI `.task` that
/// started the old ones. So the store is built over this box and told whose
/// rows it reads the moment `ensureQueue` knows.
///
/// Before that it has no owner, and a store with no owner reads nothing and
/// writes nothing: there is no cached row that belongs to nobody.
public final class CacheOwner: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    public init(_ owner: String? = nil) {
        value = owner
    }

    public var current: String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    /// The signed-in user. Changing it moves every later read and write onto
    /// that account's rows; the previous account's rows stay in the table,
    /// unreadable, until the owner-change purge deletes them.
    public func set(_ owner: String) {
        lock.lock()
        defer { lock.unlock() }
        value = owner
    }
}

/// `ApexCore.CacheStore` over GRDB, scoped to one owner exactly as
/// `GRDBWriteQueueStore` is: every statement carries `owner`, so a second
/// account on the same phone can neither read nor overwrite the first one's
/// cached schedule, profile or prefetched tracker bootstraps.
public struct GRDBCacheStore: CacheStore {
    private let pool: DatabasePool
    private let ownership: CacheOwner

    public init(pool: DatabasePool, owner: String) {
        self.init(pool: pool, owner: CacheOwner(owner))
    }

    /// The app's initializer: the owner arrives later, when the session has
    /// been restored (see `CacheOwner`).
    public init(pool: DatabasePool, owner: CacheOwner) {
        self.pool = pool
        ownership = owner
    }

    public func read(kind: CacheKind, key: String) async throws -> CacheEntry? {
        guard let owner = ownership.current else { return nil }
        return try await pool.read { db in
            guard
                let row = try Row.fetchOne(
                    db,
                    sql: "SELECT json, fetched_at FROM cache WHERE owner = ? AND kind = ? AND key = ?",
                    arguments: [owner, kind.rawValue, key]
                )
            else { return nil }
            return CacheEntry(
                kind: kind,
                key: key,
                json: row["json"],
                fetchedAt: Date(timeIntervalSince1970: row["fetched_at"])
            )
        }
    }

    public func write(_ entry: CacheEntry) async throws {
        // No owner, no row: one filed under the wrong account is the thing the
        // column exists to prevent.
        guard let owner = ownership.current else { return }
        try await pool.write { db in
            try db.execute(
                sql: """
                INSERT INTO cache (owner, kind, key, json, fetched_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(owner, kind, key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at
                """,
                arguments: [
                    owner, entry.kind.rawValue, entry.key, entry.json, entry.fetchedAt.timeIntervalSince1970,
                ]
            )
        }
    }

    public func purge(kind: CacheKind) async throws {
        guard let owner = ownership.current else { return }
        try await pool.write { db in
            try db.execute(
                sql: "DELETE FROM cache WHERE owner = ? AND kind = ?",
                arguments: [owner, kind.rawValue]
            )
        }
    }
}
