import XCTest
@testable import ApexCore

final class ClockTests: XCTestCase {
    func testTestClockRecordsSleepsAndAdvancesWithoutWaiting() async throws {
        let clock = TestClock()
        let start = clock.now
        try await clock.sleep(seconds: 2)
        try await clock.sleep(seconds: 8)
        XCTAssertEqual(clock.sleeps, [2, 8])
        XCTAssertEqual(clock.now.timeIntervalSince(start), 10)
    }

    func testAdvanceMovesTheClockWithoutRecordingASleep() {
        let clock = TestClock()
        clock.advance(by: 60)
        XCTAssertTrue(clock.sleeps.isEmpty)
        XCTAssertEqual(clock.now.timeIntervalSince1970, 60)
    }
}
