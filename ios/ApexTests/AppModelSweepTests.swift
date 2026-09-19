import ApexCore
import XCTest
@testable import Apex

/// The launch-time sweep (#221): tracker bootstraps are keyed by event *and*
/// date, two are prefetched a day, and nothing reads yesterday's again.
final class AppModelSweepTests: XCTestCase {
    @MainActor
    func testLaunchSweepDropsBootstrapsPastTheRetentionWindowOnly() async throws {
        let now = Date(timeIntervalSince1970: 1_790_078_400)
        let cache = MemoryCacheStore()
        let week = CachePolicy.trackerBootstrapRetention
        try await cache.write(CacheEntry(
            kind: .trackerBootstrap, key: "old", json: Data("a".utf8), fetchedAt: now.addingTimeInterval(-week - 60)
        ))
        try await cache.write(CacheEntry(
            kind: .trackerBootstrap, key: "recent", json: Data("b".utf8), fetchedAt: now.addingTimeInterval(-60 * 60)
        ))
        try await cache.write(CacheEntry(
            kind: .scheduleWindow, key: ScheduleCacheKey.window, json: Data("c".utf8), fetchedAt: now.addingTimeInterval(-week - 60)
        ))

        await AppModel.sweepStaleBootstraps(cache, now: now)

        let old = try await cache.read(kind: .trackerBootstrap, key: "old")
        let recent = try await cache.read(kind: .trackerBootstrap, key: "recent")
        let window = try await cache.read(kind: .scheduleWindow, key: ScheduleCacheKey.window)
        XCTAssertNil(old)
        XCTAssertNotNil(recent, "a bootstrap inside the window is still worth having offline")
        XCTAssertNotNil(window, "the sweep is for tracker bootstraps only")
    }
}
