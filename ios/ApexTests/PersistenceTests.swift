import ApexCore
import XCTest
import ApexPersistence

final class PersistenceTests: XCTestCase {
    /// Its own directory per store: `makePool` protects and un-backs-up the
    /// *containing directory* (#217), which must not be the shared temp root.
    private func makeURL() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("apex-test-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("apex.sqlite")
    }

    private func makeStore(owner: String = "u1") throws -> GRDBCacheStore {
        GRDBCacheStore(pool: try ApexDatabase.makePool(at: makeURL()), owner: owner)
    }

    func testMigratorCreatesTheCacheTableAndRoundTrips() async throws {
        let store = try makeStore()
        let entry = CacheEntry(
            kind: .scheduleWindow,
            key: "2026-09-01..2026-09-30",
            json: Data(#"{"bases":[]}"#.utf8),
            fetchedAt: Date(timeIntervalSince1970: 1_000)
        )
        try await store.write(entry)

        let read = try await store.read(kind: .scheduleWindow, key: entry.key)
        XCTAssertEqual(read?.json, entry.json)
        XCTAssertEqual(read?.fetchedAt.timeIntervalSince1970, 1_000)
    }

    func testWriteUpsertsRatherThanDuplicating() async throws {
        let store = try makeStore()
        for value in ["a", "b"] {
            try await store.write(
                CacheEntry(kind: .profile, key: "me", json: Data(value.utf8), fetchedAt: Date())
            )
        }
        let read = try await store.read(kind: .profile, key: "me")
        XCTAssertEqual(read.map { String(decoding: $0.json, as: UTF8.self) }, "b")
    }

    func testPurgeClearsOnlyItsOwnKind() async throws {
        let store = try makeStore()
        try await store.write(CacheEntry(kind: .profile, key: "me", json: Data("x".utf8), fetchedAt: Date()))
        try await store.write(CacheEntry(kind: .blocks, key: "all", json: Data("y".utf8), fetchedAt: Date()))

        try await store.purge(kind: .profile)

        let profile = try await store.read(kind: .profile, key: "me")
        let blocks = try await store.read(kind: .blocks, key: "all")
        XCTAssertNil(profile)
        XCTAssertNotNil(blocks)
    }

    func testMissingKeyReadsAsNil() async throws {
        let store = try makeStore()
        let read = try await store.read(kind: .mealsWindow, key: "nope")
        XCTAssertNil(read)
    }

    /// #217: every cache key the app writes is a constant ("current", "all",
    /// "me"), so without the `owner` column the next account to sign in on the
    /// phone reads the last one's schedule under the same key.
    func testTwoOwnersHoldTheSameKeyWithoutSeeingEachOther() async throws {
        let box = DatabasePoolBox(pool: try ApexDatabase.makePool(at: makeURL()))
        let mine = GRDBCacheStore(pool: box.pool, owner: "u1")
        let theirs = GRDBCacheStore(pool: box.pool, owner: "u2")

        try await mine.write(CacheEntry(kind: .profile, key: "me", json: Data("mine".utf8), fetchedAt: Date()))
        try await theirs.write(CacheEntry(kind: .profile, key: "me", json: Data("theirs".utf8), fetchedAt: Date()))

        let read = try await mine.read(kind: .profile, key: "me")
        let other = try await theirs.read(kind: .profile, key: "me")
        XCTAssertEqual(read.map { String(decoding: $0.json, as: UTF8.self) }, "mine", "the second account's write must not land on the first's row")
        XCTAssertEqual(other.map { String(decoding: $0.json, as: UTF8.self) }, "theirs")
    }

    func testPurgeLeavesTheOtherOwnersRowsAlone() async throws {
        let box = DatabasePoolBox(pool: try ApexDatabase.makePool(at: makeURL()))
        let mine = GRDBCacheStore(pool: box.pool, owner: "u1")
        let theirs = GRDBCacheStore(pool: box.pool, owner: "u2")
        try await mine.write(CacheEntry(kind: .scheduleWindow, key: "current", json: Data("a".utf8), fetchedAt: Date()))
        try await theirs.write(CacheEntry(kind: .scheduleWindow, key: "current", json: Data("b".utf8), fetchedAt: Date()))

        try await mine.purge(kind: .scheduleWindow)

        let purged = try await mine.read(kind: .scheduleWindow, key: "current")
        let kept = try await theirs.read(kind: .scheduleWindow, key: "current")
        XCTAssertNil(purged)
        XCTAssertNotNil(kept, "a sign-out purge is one account's rows, not the table")
    }

    /// The store the app builds in `AppModel.init` has no owner until
    /// `ensureQueue` supplies one — and a cached row belongs to nobody.
    func testAStoreWithNoOwnerYetReadsAndWritesNothing() async throws {
        let box = DatabasePoolBox(pool: try ApexDatabase.makePool(at: makeURL()))
        let owner = CacheOwner()
        let store = GRDBCacheStore(pool: box.pool, owner: owner)

        try await store.write(CacheEntry(kind: .profile, key: "me", json: Data("x".utf8), fetchedAt: Date()))
        let beforeSignIn = try await store.read(kind: .profile, key: "me")
        XCTAssertNil(beforeSignIn)

        owner.set("u1")
        let dropped = try await store.read(kind: .profile, key: "me")
        XCTAssertNil(dropped, "the ownerless write was dropped, not filed under whoever signed in next")

        try await store.write(CacheEntry(kind: .profile, key: "me", json: Data("y".utf8), fetchedAt: Date()))
        let read = try await store.read(kind: .profile, key: "me")
        XCTAssertEqual(read.map { String(decoding: $0.json, as: UTF8.self) }, "y")
    }

    /// `DatabasePool` is always in WAL mode, so the newest writes live in the
    /// `-wal` sidecar until a checkpoint: excluding `apex.sqlite` alone backed
    /// them up anyway (#217).
    func testTheContainingDirectoryIsExcludedFromBackup() throws {
        let url = makeURL()
        let box = DatabasePoolBox(pool: try ApexDatabase.makePool(at: url))
        XCTAssertNotNil(box.pool)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        let directory = url.deletingLastPathComponent()
        let excluded = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        XCTAssertEqual(excluded, true)
    }
}
