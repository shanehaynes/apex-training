import XCTest
@testable import ApexCore

/// Vectors from src/lib/schedule/__tests__/definitions.test.ts (D-024).
final class CountSpecTests: XCTestCase {
    func testStripCountSpecLiftsTheConventionOffTheCount() {
        XCTAssertEqual(CountSpec.stripCountSpec("10 each leg"), "10")
        XCTAssertEqual(CountSpec.stripCountSpec("8–10 each arm"), "8–10")
        XCTAssertEqual(CountSpec.stripCountSpec("30s per side"), "30s")
        XCTAssertEqual(CountSpec.stripCountSpec("90 sec/side"), "90 sec")
        XCTAssertEqual(CountSpec.stripCountSpec("2–3 min/side"), "2–3 min")
        XCTAssertEqual(CountSpec.stripCountSpec("10 fwd/back"), "10")
        XCTAssertEqual(CountSpec.stripCountSpec("20–30 sec each side"), "20–30 sec")
    }

    func testStripCountSpecKeepsTheRestOfTheCountIntact() {
        XCTAssertEqual(CountSpec.stripCountSpec("10 each side, light"), "10, light")
        XCTAssertEqual(CountSpec.stripCountSpec("pyramid to 3–5"), "pyramid to 3–5")
        XCTAssertEqual(CountSpec.stripCountSpec("10 total"), "10 total")
        XCTAssertEqual(CountSpec.stripCountSpec("5"), "5")
        XCTAssertNil(CountSpec.stripCountSpec(nil))
    }

    func testStripCountSpecNeverEmptiesACountThatIsOnlyItsConvention() {
        XCTAssertEqual(CountSpec.stripCountSpec("each side"), "each side")
    }

    func testCountSpecNoteStatesTheConventionForTheNotesLine() {
        XCTAssertEqual(CountSpec.countSpecNote(reps: "10 each leg", duration: nil), "Each leg.")
        XCTAssertEqual(CountSpec.countSpecNote(reps: nil, duration: "90 sec/side"), "Each side.")
        XCTAssertEqual(CountSpec.countSpecNote(reps: "10 fwd/back", duration: nil), "Forward and back.")
        XCTAssertEqual(CountSpec.countSpecNote(reps: "15 each arm", duration: nil), "Each arm.")
        XCTAssertEqual(CountSpec.countSpecNote(reps: "10 each side", duration: "30s per side"), "Each side.")
        XCTAssertNil(CountSpec.countSpecNote(reps: "5", duration: nil))
    }

    func testHasPerSideCount() {
        XCTAssertTrue(CountSpec.hasPerSideCount("8 each arm"))
        XCTAssertTrue(CountSpec.hasPerSideCount("5 per leg"))
        XCTAssertTrue(CountSpec.hasPerSideCount("10 total"))
        XCTAssertFalse(CountSpec.hasPerSideCount("8"))
        XCTAssertFalse(CountSpec.hasPerSideCount(""))
        XCTAssertFalse(CountSpec.hasPerSideCount(nil))
    }

    func testPlannedLabel() {
        XCTAssertEqual(CountSpec.plannedLabel(PlannedSet(setNumber: 1, targetWeight: "185lb", targetReps: "5")), "185lb × 5")
        XCTAssertEqual(CountSpec.plannedLabel(PlannedSet(setNumber: 1, targetReps: "10 each leg")), "× 10")
        XCTAssertEqual(CountSpec.plannedLabel(PlannedSet(setNumber: 1, targetDuration: "90 sec/side")), "90 sec")
        XCTAssertEqual(CountSpec.plannedLabel(PlannedSet(setNumber: 4)), "—")
        XCTAssertEqual(CountSpec.plannedLabel(nil), "—")
    }
}
