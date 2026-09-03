import XCTest
@testable import ApexCore

final class CachePolicyTests: XCTestCase {
    private func entry(ageSeconds: TimeInterval, now: Date) -> CacheEntry {
        CacheEntry(
            kind: .scheduleWindow,
            key: "2026-09-01..2026-09-30",
            json: Data("{}".utf8),
            fetchedAt: now.addingTimeInterval(-ageSeconds)
        )
    }

    func testFreshEntriesAreNotStale() {
        let now = Date()
        XCTAssertFalse(CachePolicy.isStale(entry(ageSeconds: 59 * 60, now: now), now: now))
    }

    func testEntriesOlderThanAnHourAreStale() {
        let now = Date()
        XCTAssertTrue(CachePolicy.isStale(entry(ageSeconds: 61 * 60, now: now), now: now))
    }

    /// Kinds are persisted as strings, so renaming one silently orphans every
    /// cached row written by an older build.
    func testKindRawValuesAreStable() {
        XCTAssertEqual(CacheKind.scheduleWindow.rawValue, "schedule_window")
        XCTAssertEqual(CacheKind.trackerBootstrap.rawValue, "tracker_bootstrap")
        XCTAssertEqual(CacheKind.allCases.count, 10)
    }
}
