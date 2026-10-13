import XCTest
@testable import ApexCore

/// `src/lib/builder/__tests__/plannedSets.test.ts`, vector for vector.
final class PlannedSetsTests: XCTestCase {
    private let pullUps = Exercise(id: "stuart-a-3", name: "Weighted Pull-Ups", category: "strength", sets: 4, reps: "4–6", weight: "~35 lbs")

    private func weights(_ rows: [PlannedSet]) -> [String?] { rows.map(\.targetWeight) }
    private func reps(_ rows: [PlannedSet]) -> [String?] { rows.map(\.targetReps) }
    private func entry(sets: Int? = nil, reps: String? = nil, weight: String? = nil, duration: String? = nil, planned: [PlannedSet]? = nil) -> Exercise {
        Exercise(id: "x", name: "x", category: "strength", sets: sets, reps: reps, weight: weight, duration: duration, plannedSets: planned)
    }

    // MARK: fields / count

    func testFieldsShowTheDimensionsTheBaseNames() {
        XCTAssertEqual(PlannedSets.fields(for: pullUps), [.weight, .reps])
        XCTAssertEqual(PlannedSets.fields(for: entry(sets: 3, duration: "20–30 sec each side")), [.duration])
    }

    func testFieldsAddADimensionOnlyTheRowsName() {
        let rows = [PlannedSet(setNumber: 1, targetDuration: "30s"), PlannedSet(setNumber: 2)]
        XCTAssertEqual(PlannedSets.fields(for: entry(sets: 2, reps: "5", planned: rows)), [.reps, .duration])
    }

    func testFieldsFallBackToWeightAndReps() {
        XCTAssertEqual(PlannedSets.fields(for: entry(sets: 3)), [.weight, .reps])
    }

    func testCountIsThePrescriptionThenTheRowsThenOne() {
        XCTAssertEqual(PlannedSets.count(for: pullUps), 4)
        XCTAssertEqual(PlannedSets.count(for: entry(planned: [PlannedSet(setNumber: 1), PlannedSet(setNumber: 2)])), 2)
        XCTAssertEqual(PlannedSets.count(for: entry(sets: 0, planned: [PlannedSet(setNumber: 1)])), 1)
        XCTAssertEqual(PlannedSets.count(for: entry()), 1)
    }

    // MARK: uniform / resize / tableRows / setting

    func testUniformRepeatsTheBaseWithOnlyTheFieldsItNames() {
        XCTAssertEqual(PlannedSets.uniform(2, base: pullUps), [
            PlannedSet(setNumber: 1, targetWeight: "~35 lbs", targetReps: "4–6"),
            PlannedSet(setNumber: 2, targetWeight: "~35 lbs", targetReps: "4–6"),
        ])
        XCTAssertEqual(PlannedSets.uniform(0, base: pullUps).count, 1)
    }

    private var ramp: [PlannedSet] {
        [
            PlannedSet(setNumber: 1, targetWeight: "20 lbs", targetReps: "5"),
            PlannedSet(setNumber: 2, targetWeight: "30 lbs", targetReps: "5"),
            PlannedSet(setNumber: 3, targetWeight: "40 lbs", targetReps: "5"),
        ]
    }

    func testResizeKeepsRowsAndRepeatsTheLastOne() {
        let grown = PlannedSets.resize(ramp, to: 5, base: pullUps)
        XCTAssertEqual(weights(grown), ["20 lbs", "30 lbs", "40 lbs", "40 lbs", "40 lbs"])
        XCTAssertEqual(grown.map(\.setNumber), [1, 2, 3, 4, 5])
        XCTAssertEqual(weights(PlannedSets.resize(ramp, to: 2, base: pullUps)), ["20 lbs", "30 lbs"])
    }

    func testResizeFillsFromTheBaseWithNothingToRepeatAndRenumbers() {
        XCTAssertEqual(PlannedSets.resize([], to: 2, base: pullUps), PlannedSets.uniform(2, base: pullUps))
        let rows = PlannedSets.resize([PlannedSet(setNumber: 7, targetWeight: "1"), PlannedSet(setNumber: 9, targetWeight: "2")], to: 2, base: pullUps)
        XCTAssertEqual(rows.map(\.setNumber), [1, 2])
    }

    func testTableRowsAreTheBaseRepeatedOrTheAuthoredRowsAtTheCount() {
        XCTAssertEqual(PlannedSets.tableRows(for: pullUps), PlannedSets.uniform(4, base: pullUps))
        var authored = pullUps
        authored.sets = 5
        authored.plannedSets = [PlannedSet(setNumber: 1, targetWeight: "20 lbs"), PlannedSet(setNumber: 2, targetWeight: "30 lbs")]
        XCTAssertEqual(weights(PlannedSets.tableRows(for: authored)), ["20 lbs", "30 lbs", "30 lbs", "30 lbs", "30 lbs"])
    }

    func testSettingEditsOneCellAndClearsOnEmptyText() {
        let rows = PlannedSets.uniform(2, base: pullUps)
        XCTAssertEqual(PlannedSets.setting(rows, setNumber: 2, field: .weight, to: " 40 lbs ")[1],
                       PlannedSet(setNumber: 2, targetWeight: "40 lbs", targetReps: "4–6"))
        let cleared = PlannedSets.setting(rows, setNumber: 1, field: .reps, to: "")
        XCTAssertEqual(cleared[0], PlannedSet(setNumber: 1, targetWeight: "~35 lbs"))
        XCTAssertEqual(cleared[1], rows[1])
    }

    // MARK: parse / unit / format

    func testParseReadsTheFirstNumberAndTheTextAroundIt() {
        XCTAssertEqual(PlannedSets.parse("~35 lbs"), .init(value: 35, prefix: "~", suffix: " lbs"))
        XCTAssertEqual(PlannedSets.parse("BW + 35 lbs"), .init(value: 35, prefix: "BW + ", suffix: " lbs"))
        XCTAssertEqual(PlannedSets.parse("4–6"), .init(value: 4, prefix: "", suffix: "–6"))
        XCTAssertEqual(PlannedSets.parse("147.5kg"), .init(value: 147.5, prefix: "", suffix: "kg"))
        XCTAssertNil(PlannedSets.parse("Moderate"))
        XCTAssertNil(PlannedSets.parse(nil))
    }

    func testUnitTakesTheTypedUnitThenAPlainBaseUnitNeverARange() {
        XCTAssertEqual(PlannedSets.unit(typed: "20 kg", base: "~35 lbs"), " kg")
        XCTAssertEqual(PlannedSets.unit(typed: "20", base: "~35 lbs"), " lbs")
        XCTAssertEqual(PlannedSets.unit(typed: "20", base: "4–6"), "")
        XCTAssertEqual(PlannedSets.unit(typed: "20", base: "Moderate"), "")
        XCTAssertEqual(PlannedSets.unit(typed: "20", base: nil), "")
    }

    func testFormatHasNoFloatNoiseOrTrailingZeros() {
        XCTAssertEqual(PlannedSets.format(147.5), "147.5")
        XCTAssertEqual(PlannedSets.format(150), "150")
        XCTAssertEqual(PlannedSets.format(0.1 + 0.2), "0.3")
    }

    // MARK: presets

    func testRampIsLinearAndKeepsTheOtherColumns() {
        let rows = PlannedSets.ramp(PlannedSets.uniform(4, base: pullUps), field: .weight, first: 20, last: 35, unit: " lbs")
        XCTAssertEqual(weights(rows), ["20 lbs", "25 lbs", "30 lbs", "35 lbs"])
        XCTAssertEqual(reps(rows), ["4–6", "4–6", "4–6", "4–6"])
    }

    func testRampSnapsWeightToPlatesAndRepsToWholeNumbers() {
        XCTAssertEqual(weights(PlannedSets.ramp(PlannedSets.uniform(4, base: pullUps), field: .weight, first: 100, last: 110)),
                       ["100", "102.5", "107.5", "110"])
        XCTAssertEqual(reps(PlannedSets.ramp(PlannedSets.uniform(4, base: pullUps), field: .reps, first: 10, last: 5)),
                       ["10", "8", "7", "5"])
    }

    func testRampGoesDownAndASingleSetGetsTheFirstValue() {
        XCTAssertEqual(weights(PlannedSets.ramp(PlannedSets.uniform(3, base: pullUps), field: .weight, first: 30, last: 20)), ["30", "25", "20"])
        XCTAssertEqual(weights(PlannedSets.ramp(PlannedSets.uniform(1, base: pullUps), field: .weight, first: 30, last: 20)), ["30"])
    }

    func testPyramidClimbsToThePeakAndBack() {
        XCTAssertEqual(weights(PlannedSets.pyramid(PlannedSets.uniform(5, base: pullUps), field: .weight, low: 135, peak: 185)),
                       ["135", "160", "185", "160", "135"])
        XCTAssertEqual(reps(PlannedSets.pyramid(PlannedSets.uniform(4, base: pullUps), field: .reps, low: 6, peak: 12)),
                       ["6", "10", "10", "6"])
        XCTAssertEqual(weights(PlannedSets.pyramid(PlannedSets.uniform(1, base: pullUps), field: .weight, low: 100, peak: 150)), ["150"])
        XCTAssertEqual(weights(PlannedSets.pyramid(PlannedSets.uniform(2, base: pullUps), field: .weight, low: 100, peak: 150)), ["100", "100"])
    }

    func testTopSetBackoffsWriteTheTopThenThePercentage() {
        XCTAssertEqual(weights(PlannedSets.topSetBackoffs(PlannedSets.uniform(5, base: pullUps), field: .weight, top: 200, backoffs: 3, percent: 80, unit: " lbs")),
                       ["200 lbs", "200 lbs", "160 lbs", "160 lbs", "160 lbs"])
        XCTAssertEqual(weights(PlannedSets.topSetBackoffs(PlannedSets.uniform(2, base: pullUps), field: .weight, top: 185, backoffs: 1, percent: 85)),
                       ["185", "157.5"])
    }

    func testTopSetBackoffsAlwaysKeepOneTopSet() {
        XCTAssertEqual(weights(PlannedSets.topSetBackoffs(PlannedSets.uniform(3, base: pullUps), field: .weight, top: 100, backoffs: 9, percent: 50)),
                       ["100", "50", "50"])
        XCTAssertEqual(weights(PlannedSets.topSetBackoffs(PlannedSets.uniform(3, base: pullUps), field: .weight, top: 100, backoffs: 0, percent: 50)),
                       ["100", "100", "100"])
    }

    // MARK: settingSets

    private var authored: Exercise {
        var entry = pullUps
        entry.plannedSets = [
            PlannedSet(setNumber: 1, targetWeight: "20 lbs", targetReps: "4–6"),
            PlannedSet(setNumber: 2, targetWeight: "25 lbs", targetReps: "4–6"),
            PlannedSet(setNumber: 3, targetWeight: "30 lbs", targetReps: "4–6"),
            PlannedSet(setNumber: 4, targetWeight: "35 lbs", targetReps: "4–6"),
        ]
        return entry
    }

    func testSettingSetsResizesTheTable() {
        XCTAssertEqual(weights(PlannedSets.settingSets(authored, to: 6).plannedSets ?? []),
                       ["20 lbs", "25 lbs", "30 lbs", "35 lbs", "35 lbs", "35 lbs"])
        XCTAssertEqual(weights(PlannedSets.settingSets(authored, to: 2).plannedSets ?? []), ["20 lbs", "25 lbs"])
    }

    func testSettingSetsLeavesTheTableWhenTheCountIsCleared() {
        let next = PlannedSets.settingSets(authored, to: nil)
        XCTAssertNil(next.sets)
        XCTAssertEqual(next.plannedSets, authored.plannedSets)
    }

    func testSettingSetsIsAPlainWriteWithoutAuthoredRows() {
        let next = PlannedSets.settingSets(pullUps, to: 6)
        XCTAssertEqual(next.sets, 6)
        XCTAssertNil(next.plannedSets)
    }
}
