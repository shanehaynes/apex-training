import XCTest
@testable import ApexCore

final class StaleAffordanceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_546_600)

    func testSpeaksOnlyWhenOldAndFailed() {
        let old = now.addingTimeInterval(-3 * 3600 - 5)
        let fresh = now.addingTimeInterval(-10 * 60)
        XCTAssertNil(StaleAffordance.label(fetchedAt: fresh, now: now, lastRefreshFailed: true))
        XCTAssertNil(StaleAffordance.label(fetchedAt: old, now: now, lastRefreshFailed: false))
        XCTAssertNil(StaleAffordance.label(fetchedAt: nil, now: now, lastRefreshFailed: true))
        XCTAssertEqual(StaleAffordance.label(fetchedAt: old, now: now, lastRefreshFailed: true), "cached · updated 3h ago")
    }

    func testBoundaryIsAnHour() {
        XCTAssertNil(StaleAffordance.label(fetchedAt: now.addingTimeInterval(-3600), now: now, lastRefreshFailed: true))
        XCTAssertEqual(StaleAffordance.label(fetchedAt: now.addingTimeInterval(-3601), now: now, lastRefreshFailed: true), "cached · updated 1h ago")
    }

    func testRelativeAge() {
        XCTAssertEqual(StaleAffordance.relativeAge(from: now.addingTimeInterval(-45 * 60), to: now), "45m")
        XCTAssertEqual(StaleAffordance.relativeAge(from: now.addingTimeInterval(-47 * 3600), to: now), "47h")
        XCTAssertEqual(StaleAffordance.relativeAge(from: now.addingTimeInterval(-50 * 3600), to: now), "2d")
    }

    func testHorizon() {
        let horizon = DayKey("2027-01-02")!
        XCTAssertNil(StaleAffordance.horizonLabel(showing: horizon, horizon: horizon))
        XCTAssertEqual(StaleAffordance.horizonLabel(showing: DayKey("2027-01-03")!, horizon: horizon), "schedule cached through Jan 2")
    }
}
