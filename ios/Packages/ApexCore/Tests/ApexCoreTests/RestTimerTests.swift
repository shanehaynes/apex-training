import XCTest
@testable import ApexCore

/// The rest countdown's state machine (D-015) over a fixed `now`: start on a
/// row's first non-empty commit, +15 s, skip, expiry, restart.
final class RestTimerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_078_400)
    private let press1 = SetKey(section: "Main Work", exerciseId: "fx-press", setNumber: 1)
    private let press2 = SetKey(section: "Main Work", exerciseId: "fx-press", setNumber: 2)
    private let row1 = SetKey(section: "Main Work", exerciseId: "fx-row", setNumber: 1)

    private func at(_ seconds: Double) -> Date { t0.addingTimeInterval(seconds) }

    // MARK: - Start

    func testAFirstNonEmptyRepsCommitStartsTheExercisesRest() {
        var timer = RestTimer()
        XCTAssertFalse(timer.isRunning)
        XCTAssertTrue(timer.setCommitted(press1, field: .reps, value: "8", rest: "90s", at: t0))
        XCTAssertTrue(timer.isRunning)
        XCTAssertEqual(timer.endsAt, at(90))
        XCTAssertEqual(timer.startedAt, t0)
        XCTAssertEqual(timer.remaining(at: t0), 90)
        XCTAssertEqual(timer.remaining(at: at(30)), 60)
        XCTAssertEqual(timer.remaining(at: at(89.6)), 1, "rounds up: 0:01 until the end has passed")
        XCTAssertEqual(timer.remaining(at: at(90)), 0)
        XCTAssertEqual(timer.remaining(at: at(120)), 0)
    }

    func testADurationCommitStartsTooButWeightDoesNot() {
        var timer = RestTimer()
        XCTAssertFalse(timer.setCommitted(press1, field: .weight, value: "135", rest: "90s", at: t0))
        XCTAssertFalse(timer.isRunning)
        XCTAssertFalse(timer.startedRows.contains(press1), "a weight-only row can still start on its reps")
        XCTAssertTrue(timer.setCommitted(press1, field: .duration, value: "45s", rest: "90s", at: t0))
        XCTAssertTrue(timer.isRunning)
    }

    func testAnEmptyOrBlankCommitStartsNothing() {
        var timer = RestTimer()
        XCTAssertFalse(timer.setCommitted(press1, field: .reps, value: "", rest: "90s", at: t0))
        XCTAssertFalse(timer.setCommitted(press1, field: .reps, value: "  ", rest: "90s", at: t0))
        XCTAssertFalse(timer.isRunning)
        XCTAssertTrue(timer.startedRows.isEmpty, "the row is not spent by an empty commit")
    }

    func testAMissingOrUnparseableRestStartsNothingButSpendsTheRow() {
        var timer = RestTimer()
        XCTAssertFalse(timer.setCommitted(press1, field: .reps, value: "8", rest: nil, at: t0))
        XCTAssertFalse(timer.setCommitted(press2, field: .reps, value: "8", rest: "as needed", at: t0))
        XCTAssertFalse(timer.setCommitted(row1, field: .reps, value: "8", rest: "", at: t0))
        XCTAssertFalse(timer.isRunning)
        XCTAssertEqual(timer.startedRows, [press1, press2, row1])
    }

    func testTheSecondKeystrokeOfARowIsNotASecondSet() {
        var timer = RestTimer()
        XCTAssertTrue(timer.setCommitted(press1, field: .reps, value: "1", rest: "90s", at: t0))
        XCTAssertFalse(timer.setCommitted(press1, field: .reps, value: "12", rest: "90s", at: at(1)))
        XCTAssertEqual(timer.endsAt, at(90), "the first commit's end stands")
        XCTAssertFalse(timer.setCommitted(press1, field: .duration, value: "30s", rest: "90s", at: at(2)))
        XCTAssertEqual(timer.endsAt, at(90))
    }

    func testAnotherRowsCommitWhileRunningRestartsWithItsExercisesRest() {
        var timer = RestTimer()
        timer.setCommitted(press1, field: .reps, value: "8", rest: "90s", at: t0)
        XCTAssertTrue(timer.setCommitted(row1, field: .reps, value: "10", rest: "2 min", at: at(40)))
        XCTAssertEqual(timer.startedAt, at(40))
        XCTAssertEqual(timer.endsAt, at(160))
        XCTAssertEqual(timer.remaining(at: at(40)), 120)
    }

    func testRowsLoggedBeforeTheTrackerOpenedNeverStartOne() {
        var timer = RestTimer()
        timer.markLogged([press1, press2])
        XCTAssertFalse(timer.setCommitted(press1, field: .reps, value: "9", rest: "90s", at: t0))
        XCTAssertFalse(timer.isRunning)
        XCTAssertTrue(timer.setCommitted(row1, field: .reps, value: "9", rest: "90s", at: t0))
    }

    // MARK: - +15 s

    func testExtendAddsFifteenSecondsToTheEnd() {
        var timer = RestTimer()
        timer.start(seconds: 60, at: t0)
        timer.extend(at: at(10))
        XCTAssertEqual(timer.endsAt, at(75))
        XCTAssertEqual(timer.startedAt, t0, "the round's start is unchanged")
        timer.extend(at: at(11))
        XCTAssertEqual(timer.endsAt, at(90))
    }

    func testExtendAtZeroGivesAFullFifteenFromNow() {
        var timer = RestTimer()
        timer.start(seconds: 60, at: t0)
        timer.extend(at: at(61))
        XCTAssertEqual(timer.endsAt, at(76))
        XCTAssertEqual(timer.remaining(at: at(61)), 15)
    }

    func testExtendWhenNothingIsRunningDoesNothing() {
        var timer = RestTimer()
        timer.extend(at: t0)
        XCTAssertFalse(timer.isRunning)
        XCTAssertNil(timer.endsAt)
    }

    // MARK: - Skip

    func testSkipClearsTheCountdownAndANewRowCanStartAgain() {
        var timer = RestTimer()
        timer.setCommitted(press1, field: .reps, value: "8", rest: "90s", at: t0)
        timer.skip()
        XCTAssertFalse(timer.isRunning)
        XCTAssertNil(timer.endsAt)
        XCTAssertNil(timer.startedAt)
        XCTAssertEqual(timer.remaining(at: at(5)), 0)
        XCTAssertFalse(timer.settle(at: at(200)), "nothing to settle after a skip")
        XCTAssertTrue(timer.setCommitted(press2, field: .reps, value: "8", rest: "90s", at: at(10)))
        XCTAssertEqual(timer.endsAt, at(100))
    }

    // MARK: - Expiry

    func testSettleFiresOnceAtZeroAndClears() {
        var timer = RestTimer()
        timer.start(seconds: 60, at: t0)
        XCTAssertFalse(timer.settle(at: at(59)))
        XCTAssertTrue(timer.isRunning, "not over yet")
        XCTAssertTrue(timer.settle(at: at(60)))
        XCTAssertFalse(timer.isRunning)
        XCTAssertFalse(timer.settle(at: at(61)), "fires once")
    }

    func testSettleWithinTheTickGraceStillFires() {
        var timer = RestTimer()
        timer.start(seconds: 60, at: t0)
        XCTAssertTrue(timer.settle(at: at(60 + RestTimer.expiryGrace)))
    }

    func testSettleLongAfterTheEndClearsSilently() {
        // The tracker was closed while the rest ran out: no late buzz on reopen.
        var timer = RestTimer()
        timer.start(seconds: 60, at: t0)
        XCTAssertFalse(timer.settle(at: at(60 + RestTimer.expiryGrace + 0.5)))
        XCTAssertFalse(timer.isRunning)
    }

    func testResetClearsTheCountdownAndTheSpentRows() {
        var timer = RestTimer()
        timer.setCommitted(press1, field: .reps, value: "8", rest: "90s", at: t0)
        timer.reset()
        XCTAssertFalse(timer.isRunning)
        XCTAssertTrue(timer.startedRows.isEmpty)
    }

    // MARK: - Progress

    func testProgressRunsZeroToOneAcrossTheRound() {
        var timer = RestTimer()
        XCTAssertEqual(timer.progress(at: t0), 0)
        timer.start(seconds: 100, at: t0)
        XCTAssertEqual(timer.progress(at: t0), 0)
        XCTAssertEqual(timer.progress(at: at(25)), 0.25)
        XCTAssertEqual(timer.progress(at: at(100)), 1)
        XCTAssertEqual(timer.progress(at: at(130)), 1, "clamped")
        timer.extend(at: at(50))
        XCTAssertEqual(timer.progress(at: at(50)), 50.0 / 115.0, accuracy: 0.0001, "+15 s stretches the round")
    }

    // MARK: - Prescription

    func testRestPrescriptionsParseAsDurationBufferDoesWithRanges() {
        XCTAssertEqual(RestTimer.seconds(fromRest: "90s"), 90)
        XCTAssertEqual(RestTimer.seconds(fromRest: "2 min"), 120)
        XCTAssertEqual(RestTimer.seconds(fromRest: "1:30"), 90)
        XCTAssertEqual(RestTimer.seconds(fromRest: "60"), 60)
        XCTAssertEqual(RestTimer.seconds(fromRest: " 45 sec "), 45)
        XCTAssertEqual(RestTimer.seconds(fromRest: "60-90s"), 60)
        XCTAssertEqual(RestTimer.seconds(fromRest: "2-3 min"), 120, "a range takes its low end with the shared unit")
        XCTAssertEqual(RestTimer.seconds(fromRest: "2–3 min"), 120)
        XCTAssertEqual(RestTimer.seconds(fromRest: "1.5-2 min"), 90)
        XCTAssertEqual(RestTimer.seconds(fromRest: "60 to 90s"), 60)
        XCTAssertNil(RestTimer.seconds(fromRest: nil))
        XCTAssertNil(RestTimer.seconds(fromRest: ""))
        XCTAssertNil(RestTimer.seconds(fromRest: "as needed"))
        XCTAssertNil(RestTimer.seconds(fromRest: "0"))
        XCTAssertNil(RestTimer.seconds(fromRest: "3 laps"))
    }
}
