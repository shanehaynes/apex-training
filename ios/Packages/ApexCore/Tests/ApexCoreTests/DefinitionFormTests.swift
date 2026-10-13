import XCTest
@testable import ApexCore

/// The library editor's diff (W10), mirroring `DefinitionEditor.changedFields`.
final class DefinitionFormTests: XCTestCase {
    private let bench = ExerciseDefinition(
        id: "bench", canonicalName: "Bench Press", aliases: ["Barbell Bench"], category: "strength",
        muscleGroups: ["chest", "triceps"], equipment: ["barbell"], techniqueNotes: "Arch lightly.",
        isUnilateral: false, defaultSets: 3, defaultReps: "5", defaultWeight: "185 lb"
    )

    func testAnUntouchedFormChangesNothing() {
        let form = DefinitionForm(definition: bench)
        XCTAssertEqual(form.muscleGroups, "chest, triceps")
        XCTAssertEqual(form.defaultSets, "3")
        XCTAssertEqual(form.defaultDuration, "")
        XCTAssertEqual(form.changedFields(against: bench), [:])
        XCTAssertFalse(form.isRenaming(bench))
    }

    func testARenameTravelsAloneAndTheHintKnowsIt() {
        var form = DefinitionForm(definition: bench)
        form.name = " Flat Bench Press "
        XCTAssertTrue(form.isRenaming(bench))
        XCTAssertEqual(form.changedFields(against: bench), ["canonical_name": .string("Flat Bench Press")])

        form.name = "   "
        XCTAssertFalse(form.isRenaming(bench))
        XCTAssertEqual(form.changedFields(against: bench), [:])
    }

    func testListsAreSplitOnCommasAndOnlySentWhenTheyChanged() {
        var form = DefinitionForm(definition: bench)
        form.muscleGroups = "chest , triceps,"          // same list, different spelling
        form.equipment = "barbell, bench"
        form.isUnilateral = true
        form.category = "skill"
        XCTAssertEqual(form.changedFields(against: bench), [
            "equipment": .array([.string("barbell"), .string("bench")]),
            "is_unilateral": .bool(true),
            "category": .string("skill"),
        ])
    }

    /// "Always log" travels as the whole column, in column order, only when it changed.
    func testAlwaysLogIsSentAsTheWholeColumnWhenItChanged() {
        var form = DefinitionForm(definition: bench)
        XCTAssertEqual(form.logFields, [])
        XCTAssertEqual(form.changedFields(against: bench), [:])
        form.logFields = [.duration, .weight]
        XCTAssertEqual(form.changedFields(against: bench), ["log_fields": .array([.string("weight"), .string("duration")])])

        let dips = ExerciseDefinition(id: "dips", canonicalName: "Ring Dips", category: "strength", logFields: ["weight"])
        var undo = DefinitionForm(definition: dips)
        XCTAssertEqual(undo.logFields, [.weight])
        XCTAssertEqual(undo.changedFields(against: dips), [:])
        undo.logFields = []
        // Taking the tracker's addition back off clears the column rather than dropping the key.
        XCTAssertEqual(undo.changedFields(against: dips), ["log_fields": .array([])])
    }

    /// The improvement over the web: a cleared default is an explicit null.
    func testClearedDefaultsAreSentAsNulls() {
        var form = DefinitionForm(definition: bench)
        form.defaultSets = ""
        form.defaultReps = " 8 "
        form.defaultWeight = ""
        form.defaultRest = "2 min"
        form.techniqueNotes = ""
        XCTAssertEqual(form.changedFields(against: bench), [
            "default_sets": .null,
            "default_reps": .string("8"),
            "default_weight": .null,
            "default_rest": .string("2 min"),
            "technique_notes": .null,
        ])

        form.defaultSets = "4"
        XCTAssertEqual(form.changedFields(against: bench)["default_sets"], .number(4))
        form.defaultSets = "four"
        // Unparsable reads as blank, which clears — the web's numeric input
        // cannot even hold this; the phone's number pad makes it rare.
        XCTAssertEqual(form.changedFields(against: bench)["default_sets"], .null)
    }
}
