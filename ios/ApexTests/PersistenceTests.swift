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

    func testMissingKeyReadsAsNil() async throws {
        let store = try makeStore()
        let read = try await store.read(kind: .mealsWindow, key: "nope")
        XCTAssertNil(read)
    }
}
