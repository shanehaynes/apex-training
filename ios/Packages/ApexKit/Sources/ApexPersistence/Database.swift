import ApexCore
import Foundation
import GRDB

/// The on-device SQLite file: read cache, tracker write queue, and local coach
/// conversations (architecture.md §6–7).
public enum ApexDatabase {
    /// Application Support, excluded from iCloud backup — it is all re-fetchable,
    /// and backing it up would put workout data in a second place for no gain.
    public static func makePool(at url: URL? = nil) throws -> DatabasePool {
        let fileURL = try url ?? defaultURL()
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let pool = try DatabasePool(path: fileURL.path)
        try migrator.migrate(pool)
        try excludeFromBackup(fileURL)
        return pool
    }

    private static func defaultURL() throws -> URL {
        try FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Apex", isDirectory: true)
            .appendingPathComponent("apex.sqlite")
    }

    private static func excludeFromBackup(_ url: URL) throws {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    /// Migrations are append-only and never edited once shipped — an installed
    /// app has already run them.
    public static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        migrator.registerMigration("v1_cache") { db in
            try db.create(table: "cache") { table in
                table.column("kind", .text).notNull()
                table.column("key", .text).notNull()
                table.column("json", .blob).notNull()
                table.column("fetched_at", .double).notNull()
                table.primaryKey(["kind", "key"])
            }
        }

        // W4: the tracker write queue (architecture.md §7). `owner` is the
        // signed-in user: unsynced ops outlive a sign-out and must never flush
        // under another account.
        migrator.registerMigration("v2_tracker_ops") { db in
            try db.create(table: "tracker_ops") { table in
                table.autoIncrementedPrimaryKey("id")
                table.column("owner", .text).notNull()
                table.column("event_id", .text).notNull()
                table.column("event_date", .text).notNull()
                table.column("action", .text).notNull()
                table.column("payload", .blob).notNull()
                table.column("created_at", .double).notNull()
                table.column("attempts", .integer).notNull().defaults(to: 0)
                table.column("last_error", .text)
                table.column("state", .text).notNull()
            }
            try db.create(index: "tracker_ops_session", on: "tracker_ops", columns: ["owner", "event_id", "event_date", "state", "id"])
        }

        return migrator
    }
}
