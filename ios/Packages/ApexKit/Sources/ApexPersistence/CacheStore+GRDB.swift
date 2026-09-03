import ApexCore
import Foundation
import GRDB

/// `ApexCore.CacheStore` over GRDB.
public struct GRDBCacheStore: CacheStore {
    private let pool: DatabasePool

    public init(pool: DatabasePool) {
        self.pool = pool
    }

    public func read(kind: CacheKind, key: String) async throws -> CacheEntry? {
        try await pool.read { db in
            guard
                let row = try Row.fetchOne(
                    db,
                    sql: "SELECT json, fetched_at FROM cache WHERE kind = ? AND key = ?",
                    arguments: [kind.rawValue, key]
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
        try await pool.write { db in
            try db.execute(
                sql: """
                INSERT INTO cache (kind, key, json, fetched_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(kind, key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at
                """,
                arguments: [
                    entry.kind.rawValue, entry.key, entry.json, entry.fetchedAt.timeIntervalSince1970,
                ]
            )
        }
    }

    public func purge(kind: CacheKind) async throws {
        try await pool.write { db in
            try db.execute(sql: "DELETE FROM cache WHERE kind = ?", arguments: [kind.rawValue])
        }
    }
}
