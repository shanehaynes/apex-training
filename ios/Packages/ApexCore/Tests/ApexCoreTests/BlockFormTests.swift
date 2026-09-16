import XCTest
@testable import ApexCore

/// The block editor's snapping and row shaping (W10). Week counts are not
/// tested here because they are not computed here — the server sends them.
final class BlockFormTests: XCTestCase {
    private func day(_ s: String) -> DayKey { DayKey(s)! }

    func testStartSnapsToTheMondayOfItsWeek() {
        // 2026-09-09 is a Wednesday; 2026-09-13 a Sunday; 2026-09-07 the Monday.
        XCTAssertEqual(BlockDates.mondayOf(day("2026-09-09")), day("2026-09-07"))
        XCTAssertEqual(BlockDates.mondayOf(day("2026-09-13")), day("2026-09-07"))
        XCTAssertEqual(BlockDates.mondayOf(day("2026-09-07")), day("2026-09-07"))
    }

    func testEndSnapsToTheSundayOfItsWeekAndStoresTheMondayAfter() {
        XCTAssertEqual(BlockDates.sundayOf(day("2026-09-30")), day("2026-10-04"))
        XCTAssertEqual(BlockDates.sundayOf(day("2026-10-04")), day("2026-10-04"))
        XCTAssertEqual(BlockDates.sundayOf(day("2026-10-05")), day("2026-10-11"))

        let form = BlockForm(startDay: day("2026-09-09"), endInclusive: day("2026-09-30"))
        XCTAssertEqual(form.snappedStart, day("2026-09-07"))
        XCTAssertEqual(form.snappedEndExclusive, day("2026-10-05"))
    }

    func testBlankTargetsAreOmittedAndQuantitiesCarryTheirUnit() {
        var form = BlockForm.new(today: day("2026-09-09"))
        XCTAssertEqual(form.snappedStart, day("2026-09-07"))
        XCTAssertEqual(form.snappedEndExclusive, day("2026-10-05"))
        XCTAssertEqual(form.weeklyTargets(), [:])

        form.cardioMinutes = " 240 "
        form.strengthSessions = "2"
        form.longSessionMinutes = "-5"      // not a target: dropped, as the web drops it
        form.distance = "20"
        form.distanceUnit = "km"
        XCTAssertEqual(form.weeklyTargets(), [
            "cardioMinutes": .number(240),
            "strengthSessions": .number(2),
            "distance": .object(["value": .number(20), "unit": .string("km")]),
        ])
        XCTAssertEqual(form.weeklyTargetsValue(), WeeklyTargets(
            cardioMinutes: 240, distance: .init(value: 20, unit: "km"), strengthSessions: 2
        ))
    }

    func testTheRowCarriesEveryColumnWithNullsForClearedOptionals() {
        var form = BlockForm(startDay: day("2026-09-07"), endInclusive: day("2026-10-04"))
        form.name = "Base"
        form.intent = "Aerobic base\n"
        XCTAssertEqual(form.row(), [
            "name": .string("Base"),
            "intent": .string("Aerobic base"),
            "phase": .null,
            "objective_id": .null,
            "start_date": .string("2026-09-07"),
            "end_date_exclusive": .string("2026-10-05"),
            "weekly_targets": .object([:]),
        ])
        form.phase = "build"
        form.objectiveId = "obj-1"
        XCTAssertEqual(form.row()["phase"], .string("build"))
        XCTAssertEqual(form.row()["objective_id"], .string("obj-1"))
    }

    func testOpeningAnExistingBlockShowsTheInclusiveSunday() {
        let block = BlockSummary(
            id: "blk-1", name: "Base", intent: "x", phase: "base", objectiveId: "obj-1",
            startDate: "2026-08-31", endDateExclusive: "2026-09-28", weeks: 4,
            weeklyTargets: WeeklyTargets(cardioMinutes: 60, vert: .init(value: 1500, unit: "m"), strengthSessions: 1.5)
        )
        let form = BlockForm(block: block)
        XCTAssertEqual(form.startDay, day("2026-08-31"))
        XCTAssertEqual(form.endInclusive, day("2026-09-27"))
        XCTAssertEqual(form.cardioMinutes, "60")
        XCTAssertEqual(form.strengthSessions, "1.5")
        XCTAssertEqual(form.vert, "1500")
        XCTAssertEqual(form.vertUnit, "m")
        XCTAssertEqual(form.distance, "")
        XCTAssertTrue(form.canSave)
        // Round trip: the row the editor would send back is the block it opened.
        XCTAssertEqual(form.row()["start_date"], .string("2026-08-31"))
        XCTAssertEqual(form.row()["end_date_exclusive"], .string("2026-09-28"))
    }
}
