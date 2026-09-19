import ApexCore
import Foundation
import GRDB

/// The on-device SQLite file: read cache, tracker write queue, and local coach
/// conversations (architecture.md §6–7).
public enum ApexDatabase {
    /// Stated rather than inherited from the container's default, so a change
    /// to that default can never quietly downgrade it.
    ///
    /// Not `.completeUnlessOpen`, which would be stronger: the
    /// `BGAppRefreshTask` opens this file in a cold process that the system can
    /// start while the device is locked, and that open has to succeed. This
    /// class keeps the file sealed until the user has unlocked once since boot
    /// — which is the real threat, a phone taken and never unlocked again.
    public static var protection: FileProtectionType { .completeUntilFirstUserAuthentication }

    /// Application Support, excluded from iCloud backup — it is all re-fetchable,
    /// and backing it up would put workout data in a second place for no gain.
    public static func makePool(at url: URL? = nil) throws -> DatabasePool {
        let fileURL = try url ?? defaultURL()
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Before the open, because SQLite creates `-wal` and `-shm` itself and
        // a new file inherits its directory's protection class.
        protect(directory.path)
        let pool = try DatabasePool(path: fileURL.path)
        try migrator.migrate(pool)
        // And again by name: a database an earlier build created still carries
        // whatever class it was made with.
        for path in [fileURL.path, fileURL.path + "-wal", fileURL.path + "-shm"] {
            protect(path)
        }
        // The *directory*, not the main file: `DatabasePool` is always in WAL
        // mode, so the most recent writes — cached schedule, coach
        // conversations — sit in the `-wal` sidecar until a checkpoint folds
        // them back in, and excluding only `apex.sqlite` backs them up anyway.
        try excludeFromBackup(directory)
        return pool
    }

    /// Best effort: the Simulator's filesystem does not implement data
    /// protection, and refusing to open the database over a class the platform
    /// ignores would cost more than it buys.
    private static func protect(_ path: String) {
        guard FileManager.default.fileExists(atPath: path) else { return }
        try? FileManager.default.setAttributes([.protectionKey: protection], ofItemAtPath: path)
    }

    private static func defaultURL() throws -> URL {
        try FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Apex", isDirectory: true)
            .appendingPathComponent("apex.sqlite")
    }

    /// Excluding a directory covers every file in it, now and later.
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

        // W6: local coach conversations (D-013, D-025). Shaped like the future
        // server table plus `owner` (same reason as tracker_ops) and `kind`
        // (turn · notice · stopped — rows without API content are display-only).
        migrator.registerMigration("v3_conversations") { db in
            try db.create(table: "conversations") { table in
                table.column("id", .text).primaryKey()
                table.column("owner", .text).notNull()
                table.column("mode", .text).notNull()
                table.column("title", .text)
                table.column("created_at", .double).notNull()
                table.column("updated_at", .double).notNull()
            }
            try db.create(index: "conversations_owner_recent", on: "conversations", columns: ["owner", "mode", "updated_at"])
            try db.create(table: "messages") { table in
                table.column("id", .text).primaryKey()
                table.column("conversation_id", .text).notNull()
                    .references("conversations", onDelete: .cascade)
                table.column("role", .text).notNull()
                table.column("api_content_json", .blob)
                table.column("display_text", .text)
                table.column("kind", .text).notNull().defaults(to: "turn")
                table.column("created_at", .double).notNull()
            }
            try db.create(index: "messages_conversation_order", on: "messages", columns: ["conversation_id", "created_at"])
        }

        // The read cache gets the `owner` column `tracker_ops` and
        // `conversations` have had all along: every cache key is a constant
        // ("current", "all", "me"), so without it a row left by the previous
        // account is not merely stale, it is the next account's schedule.
        migrator.registerMigration("v4_cache_owner") { db in
            // SQLite cannot add a column to a primary key, and the rows that
            // are already there belong to whoever was signed in when they were
            // written — unknowable here. All of it is re-fetchable, and
            // guessing an owner is the bug this migration closes, so they go.
            try db.drop(table: "cache")
            try db.create(table: "cache") { table in
                table.column("owner", .text).notNull()
                table.column("kind", .text).notNull()
                table.column("key", .text).notNull()
                table.column("json", .blob).notNull()
                table.column("fetched_at", .double).notNull()
                table.primaryKey(["owner", "kind", "key"])
            }
        }

        return migrator
    }
}
