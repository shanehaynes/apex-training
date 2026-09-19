import ApexCore
import XCTest
import ApexPersistence

final class PersistenceTests: XCTestCase {
    private func makeStore() throws -> GRDBCacheStore {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("apex-test-\(UUID().uuidString).sqlite")
        return GRDBCacheStore(pool: try ApexDatabase.makePool(at: url))
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

    /// #221: cancelling one workout deleted every cached tracker bootstrap,
    /// including the prefetch for tomorrow's.
    func testDeleteRemovesOneRowAndLeavesTheRestOfTheKind() async throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_790_078_400)
        try await store.write(CacheEntry(kind: .trackerBootstrap, key: "e1__2026-09-22", json: Data("a".utf8), fetchedAt: now))
        try await store.write(CacheEntry(kind: .trackerBootstrap, key: "e2__2026-09-23", json: Data("b".utf8), fetchedAt: now))

        try await store.delete(kind: .trackerBootstrap, key: "e1__2026-09-22")

        let cancelled = try await store.read(kind: .trackerBootstrap, key: "e1__2026-09-22")
        let tomorrow = try await store.read(kind: .trackerBootstrap, key: "e2__2026-09-23")
        XCTAssertNil(cancelled)
        XCTAssertNotNil(tomorrow)
    }

    func testAgeSweepDropsOnlyOldRowsOfThatKind() async throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_790_078_400)
        let cutoff = now.addingTimeInterval(-CachePolicy.trackerBootstrapRetention)
        try await store.write(CacheEntry(kind: .trackerBootstrap, key: "old", json: Data("a".utf8), fetchedAt: cutoff.addingTimeInterval(-60)))
        try await store.write(CacheEntry(kind: .trackerBootstrap, key: "fresh", json: Data("b".utf8), fetchedAt: now))
        try await store.write(CacheEntry(kind: .profile, key: "me", json: Data("c".utf8), fetchedAt: cutoff.addingTimeInterval(-60)))

        try await store.purge(kind: .trackerBootstrap, fetchedBefore: cutoff)

        let old = try await store.read(kind: .trackerBootstrap, key: "old")
        let fresh = try await store.read(kind: .trackerBootstrap, key: "fresh")
        let profile = try await store.read(kind: .profile, key: "me")
        XCTAssertNil(old)
        XCTAssertNotNil(fresh)
        XCTAssertNotNil(profile)
    }

    func testMissingKeyReadsAsNil() async throws {
        let store = try makeStore()
        let read = try await store.read(kind: .mealsWindow, key: "nope")
        XCTAssertNil(read)
    }
}
