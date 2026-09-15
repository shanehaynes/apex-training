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

    func testHeldClockHoldsASleepUntilOpenedThenLetsLaterOnesThrough() async throws {
        let clock = HeldClock()
        let sleeper = Task { try await clock.sleep(seconds: 5) }
        while clock.heldSleeps == 0 { await Task.yield() }
        XCTAssertEqual(clock.sleeps, [5])

        clock.open()
        try await sleeper.value
        XCTAssertEqual(clock.heldSleeps, 0)
        try await clock.sleep(seconds: 1)
        XCTAssertEqual(clock.sleeps, [5, 1])
        XCTAssertEqual(clock.now.timeIntervalSince1970, 0)
    }

    func testACancelledHeldSleepWaitsForOpenThenThrows() async {
        let clock = HeldClock()
        let sleeper = Task { try await clock.sleep(seconds: 5) }
        while clock.heldSleeps == 0 { await Task.yield() }

        sleeper.cancel()
        XCTAssertEqual(clock.heldSleeps, 1)
        clock.open()
        do {
            try await sleeper.value
            XCTFail("a cancelled sleep returned")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
    }
}
