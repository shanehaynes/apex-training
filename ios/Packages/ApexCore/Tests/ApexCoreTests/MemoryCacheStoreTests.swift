import XCTest
@testable import ApexCore

/// The in-memory store is the contract every model test runs against, so the
/// row-level delete and the age sweep are proved here as well as over GRDB.
final class MemoryCacheStoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_078_400)

    private func entry(_ kind: CacheKind, _ key: String, age: TimeInterval = 0, now: Date) -> CacheEntry {
        CacheEntry(kind: kind, key: key, json: Data(key.utf8), fetchedAt: now.addingTimeInterval(-age))
    }

    /// The bug behind #221: cancelling one workout must not take the prefetched
    /// bootstrap for the next one with it.
    func testDeleteRemovesOneRowAndLeavesTheRestOfTheKind() async throws {
        let store = MemoryCacheStore()
        try await store.write(entry(.trackerBootstrap, "today", now: now))
        try await store.write(entry(.trackerBootstrap, "tomorrow", now: now))

        try await store.delete(kind: .trackerBootstrap, key: "today")

        let today = try await store.read(kind: .trackerBootstrap, key: "today")
        let tomorrow = try await store.read(kind: .trackerBootstrap, key: "tomorrow")
        XCTAssertNil(today)
        XCTAssertNotNil(tomorrow)
    }

    func testDeletingAMissingKeyIsNotAnError() async throws {
        let store = MemoryCacheStore()
        try await store.delete(kind: .trackerBootstrap, key: "never-written")
        let all = await store.all
        XCTAssertTrue(all.isEmpty)
    }

    func testPurgeBeforeDropsOnlyOldRowsOfThatKind() async throws {
        let store = MemoryCacheStore()
        let week = CachePolicy.trackerBootstrapRetention
        try await store.write(entry(.trackerBootstrap, "old", age: week + 60, now: now))
        try await store.write(entry(.trackerBootstrap, "fresh", age: 60, now: now))
        try await store.write(entry(.profile, "me", age: week + 60, now: now))

        try await store.purge(kind: .trackerBootstrap, fetchedBefore: now.addingTimeInterval(-week))

        let old = try await store.read(kind: .trackerBootstrap, key: "old")
        let fresh = try await store.read(kind: .trackerBootstrap, key: "fresh")
        let profile = try await store.read(kind: .profile, key: "me")
        XCTAssertNil(old)
        XCTAssertNotNil(fresh, "a row inside the retention window survives")
        XCTAssertNotNil(profile, "another kind is never touched by this sweep")
    }

    /// A row written exactly at the cutoff is kept: the sweep is strictly older-than.
    func testPurgeBeforeKeepsARowAtTheCutoff() async throws {
        let store = MemoryCacheStore()
        try await store.write(entry(.trackerBootstrap, "edge", now: now))
        try await store.purge(kind: .trackerBootstrap, fetchedBefore: now)
        let edge = try await store.read(kind: .trackerBootstrap, key: "edge")
        XCTAssertNotNil(edge)
    }

    func testTrackerBootstrapRetentionIsAWeek() {
        XCTAssertEqual(CachePolicy.trackerBootstrapRetention, 7 * 24 * 60 * 60)
    }
}
