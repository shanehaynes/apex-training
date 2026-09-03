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

        return migrator
    }
}
