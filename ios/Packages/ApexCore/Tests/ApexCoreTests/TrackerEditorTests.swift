import XCTest
@testable import ApexCore

/// The edit half of the tracker, mirroring the edit-related cases of
/// src/lib/tracking/__tests__/plan.test.ts and the mutation behaviour of
/// useWorkoutSession.ts. Builds on the committed bootstrap fixture: Fixture
/// Press (set 1 logged 120 lb × 3, set 2 shadowed 110 lb × 3) and a cardio row.
final class TrackerEditorTests: XCTestCase {
    private let press = CardioKey(section: "exercise", exerciseId: "fx-press")
    private let row = CardioKey(section: "exercise", exerciseId: "fx-row")
    private var set1: SetKey { SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 1) }
    private var set2: SetKey { SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 2) }

    private func editor() throws -> TrackerEditor {
        TrackerEditor(bootstrap: try TestFixtures.bootstrap(), session: fixtureSession)
    }

    /// A hand-built model: a bench with three planned sets (185lb × 5), a
    /// stretch prescribed by duration only, a cardio run, and a climbing pitch.
    private func handBuilt(shadowOnBench: Bool = false, resolvedOnBench: String? = nil) -> TrackerEditor {
        let bench = TrackedExercise(
            section: "exercise",
            exercise: Exercise(id: "ub-1", name: "Bench Press", category: "strength", definitionId: "def-bench"),
            isCardio: false,
            sets: (1...3).map {
                TrackedSet(
                    setNumber: $0, planned: PlannedSet(setNumber: $0, targetWeight: "185lb", targetReps: "5"),
                    shadow: shadowOnBench ? ShadowValues(weight: "200", reps: "5", duration: "") : nil,
                    resolvedPlannedWeight: resolvedOnBench
                )
            }
        )
        let stretch = TrackedExercise(
            section: "warmup",
            exercise: Exercise(id: "ub-cd-1", name: "Doorway Pec Stretch", category: "stretch"),
            isCardio: false,
            sets: [TrackedSet(setNumber: 1, planned: PlannedSet(setNumber: 1, targetDuration: "60s"))]
        )
        let run = TrackedExercise(
            section: "exercise",
            exercise: Exercise(id: "run-1", name: "Zone 2 Run", category: "cardio"),
            isCardio: true, sets: [],
            cardio: CardioLog(shadow: CardioShadow(durationMinutes: "40", distance: "5 mi", elevationGain: "", avgHeartRate: "145"))
        )
        let pitch = TrackedExercise(
            section: "exercise",
            exercise: Exercise(id: "p-1", name: "Pitch 1", category: "climbing", grade: "5.10c"),
            isCardio: false,
            sets: [TrackedSet(setNumber: 1, planned: PlannedSet(setNumber: 1, targetWeight: "5.10c"))]
        )
        return TrackerEditor(groups: [
            TrackedSectionGroup(section: "warmup", label: "Warm-Up", exercises: [stretch]),
            TrackedSectionGroup(section: "exercise", label: "Main Work", exercises: [bench, run, pitch]),
        ], session: SessionKey(eventId: "eid", eventDate: "2026-07-06"))
    }

    // MARK: - Construction

    func testInitFromTheFixtureIsClean() throws {
        let editor = try editor()
        XCTAssertEqual(editor.groups.count, 1)
        XCTAssertEqual(editor.groups[0].exercises.count, 2)
        XCTAssertFalse(editor.isDirty)
        XCTAssertEqual(editor.set(at: set1)?.actualWeight, "120 lb")
        XCTAssertEqual(editor.set(at: set2)?.shadow?.weight, "110 lb")
    }

    // MARK: - Set edits

    func testTypingMarksTheSetDirtyAndKeepsItsShadow() throws {
        var editor = try editor()
        XCTAssertTrue(editor.setValue("115 lb", .weight, at: set2))
        XCTAssertEqual(editor.set(at: set2)?.actualWeight, "115 lb")
        XCTAssertEqual(editor.dirtySets, [set2])
        // The shadow is committed only by focus, never by typing into another field.
        XCTAssertNotNil(editor.set(at: set2)?.shadow)
        XCTAssertFalse(editor.setValue("1", .reps, at: SetKey(section: "exercise", exerciseId: "nope", setNumber: 1)))
    }

    func testCommitShadowCopiesOnlyTheRenderedFieldsAndClearsIt() throws {
        var editor = try editor()
        XCTAssertTrue(editor.commitShadow(at: set2, fields: [.weight, .reps]))
        let set = try XCTUnwrap(editor.set(at: set2))
        XCTAssertEqual(set.actualWeight, "110 lb")
        XCTAssertEqual(set.actualReps, "3")
        XCTAssertEqual(set.actualDuration, "")
        XCTAssertNil(set.shadow)
        XCTAssertEqual(editor.dirtySets, [set2])

        // Nothing left to commit; a row that never had a shadow stays clean.
        XCTAssertFalse(editor.commitShadow(at: set2, fields: [.weight]))
        var clean = try self.editor()
        XCTAssertFalse(clean.commitShadow(at: set1, fields: [.weight, .reps]))
        XCTAssertFalse(clean.isDirty)
    }

    /// `ghostOf`: a shadowed set whose percentage target resolved commits
    /// today's load as its weight, last session's reps as its reps.
    func testCommitShadowTakesTheResolvedLoadForWeight() throws {
        var editor = handBuilt(shadowOnBench: true, resolvedOnBench: "187.5 lb")
        let key = SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1)
        XCTAssertEqual(TrackerEditor.ghost(of: try XCTUnwrap(editor.set(at: key)), field: .weight), "187.5 lb")
        XCTAssertTrue(editor.commitShadow(at: key, fields: [.weight, .reps]))
        let set = try XCTUnwrap(editor.set(at: key))
        XCTAssertEqual(set.actualWeight, "187.5 lb")
        XCTAssertEqual(set.actualReps, "5")

        // Without a shadow there is nothing to commit, resolved load or not:
        // the load is only a hint then.
        var unshadowed = handBuilt(resolvedOnBench: "187.5 lb")
        XCTAssertEqual(TrackerEditor.ghost(of: try XCTUnwrap(unshadowed.set(at: key)), field: .weight), "")
        XCTAssertFalse(unshadowed.commitShadow(at: key, fields: [.weight, .reps]))
    }

    /// What each field shows: a committing ghost (shadow, resolved load for
    /// weight), a non-committing hint (resolved, no shadow), or nothing.
    func testFieldPrompts() throws {
        let key = SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1)
        let both = try XCTUnwrap(handBuilt(shadowOnBench: true, resolvedOnBench: "187.5 lb").set(at: key))
        XCTAssertEqual(TrackerEditor.prompt(of: both, field: .weight), .init(text: "187.5 lb", commits: true))
        XCTAssertEqual(TrackerEditor.prompt(of: both, field: .reps), .init(text: "5", commits: true))
        let hintOnly = try XCTUnwrap(handBuilt(resolvedOnBench: "187.5 lb").set(at: key))
        XCTAssertEqual(TrackerEditor.prompt(of: hintOnly, field: .weight), .init(text: "187.5 lb", commits: false))
        XCTAssertEqual(TrackerEditor.prompt(of: hintOnly, field: .reps), .init(text: "", commits: false))
        let shadowOnly = try XCTUnwrap(handBuilt(shadowOnBench: true).set(at: key))
        XCTAssertEqual(TrackerEditor.prompt(of: shadowOnly, field: .weight), .init(text: "200", commits: true))
    }

    func testCommitShadowHonoursTheVisibleFieldList() throws {
        var editor = try editor()
        editor.commitShadow(at: set2, fields: [.reps])
        XCTAssertEqual(editor.set(at: set2)?.actualReps, "3")
        // The weight ghost was not rendered, so it never enters the log.
        XCTAssertEqual(editor.set(at: set2)?.actualWeight, "")
    }

    func testUseLastCommitsEveryShadowedRowOnce() throws {
        var editor = handBuilt(shadowOnBench: true)
        XCTAssertEqual(editor.commitAllShadows(section: "exercise", exerciseId: "ub-1", fields: [.weight, .reps]), 3)
        XCTAssertEqual(editor.dirtySets.count, 3)
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.sets.map(\.actualWeight), ["200", "200", "200"])
        XCTAssertEqual(editor.commitAllShadows(section: "exercise", exerciseId: "ub-1", fields: [.weight, .reps]), 0)
    }

    // MARK: - Cardio

    func testCardioShadowCommitsPerFieldAndLeavesTheOthers() {
        var editor = handBuilt()
        let key = CardioKey(section: "exercise", exerciseId: "run-1")
        XCTAssertTrue(editor.commitCardioShadow(.distance, at: key))
        let cardio = editor.exercise(section: "exercise", id: "run-1")?.cardio
        XCTAssertEqual(cardio?.distance, "5 mi")
        XCTAssertEqual(cardio?.durationMinutes, "")
        XCTAssertEqual(cardio?.shadow?.distance, "")
        XCTAssertEqual(cardio?.shadow?.durationMinutes, "40")
        XCTAssertEqual(editor.dirtyCardio, [key])
        // An empty ghost has nothing to commit.
        XCTAssertFalse(editor.commitCardioShadow(.elevationGain, at: key))
        XCTAssertTrue(editor.setCardio("42.5", .durationMinutes, at: key))
        XCTAssertEqual(editor.exercise(section: "exercise", id: "run-1")?.cardio?.durationMinutes, "42.5")
    }

    // MARK: - Extra sets

    func testExtraSetNumberingContinuesFromTheHighestSet() throws {
        var editor = try editor()
        XCTAssertEqual(editor.addExtraSet(section: "exercise", exerciseId: "fx-press"), 3)
        let extra = try XCTUnwrap(editor.set(at: SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 3)))
        XCTAssertTrue(extra.isExtra)
        XCTAssertEqual(extra.planned, PlannedSet(setNumber: 3))
        XCTAssertFalse(extra.isLogged)
        // An empty extra set has nothing to persist.
        XCTAssertFalse(editor.isDirty)

        // A hydrated extra numbered 5 pushes the next to 6; gaps are not reused.
        var hydrated = try self.editor()
        hydrated.apply(SavePayload(setLogs: [setRow(5)]))
        XCTAssertEqual(hydrated.addExtraSet(section: "exercise", exerciseId: "fx-press"), 6)
        XCTAssertNil(hydrated.addExtraSet(section: "exercise", exerciseId: "missing"))
    }

    func testRemoveExtraDropsThePendingUpsertBeforeRecordingTheRemoval() throws {
        var editor = try editor()
        let n = try XCTUnwrap(editor.addExtraSet(section: "exercise", exerciseId: "fx-press"))
        let key = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: n)
        editor.setValue("8", .reps, at: key)
        XCTAssertTrue(editor.dirtySets.contains(key))
        XCTAssertTrue(editor.removeExtraSet(at: key))
        XCTAssertNil(editor.set(at: key))
        XCTAssertFalse(editor.dirtySets.contains(key))
        XCTAssertEqual(editor.removedSets, [key])
        // A planned set can never be removed.
        XCTAssertFalse(editor.removeExtraSet(at: set1))
        XCTAssertNotNil(editor.set(at: set1))
    }

    // MARK: - Save payload

    func testTakeSavePayloadSerialisesDirtyKeysThenClears() throws {
        var editor = try editor()
        editor.commitShadow(at: set2, fields: [.weight, .reps])
        editor.setCardio("30", .durationMinutes, at: row)
        let n = try XCTUnwrap(editor.addExtraSet(section: "exercise", exerciseId: "fx-press"))
        let extraKey = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: n)
        editor.setValue("5", .reps, at: extraKey)
        editor.removeExtraSet(at: extraKey)

        let payload = try XCTUnwrap(editor.takeSavePayload())
        XCTAssertEqual(payload.setLogs.map(\.setNumber), [2])
        XCTAssertEqual(payload.setLogs[0].actualWeight, "110 lb")
        XCTAssertEqual(payload.cardioLogs.map(\.durationMinutes), [30])
        // Edited then removed: only in removedSets, never in both lists.
        XCTAssertEqual(payload.removedSets, [extraKey])
        XCTAssertTrue(payload.setKeys.contains(extraKey))
        XCTAssertFalse(payload.setLogs.contains { $0.key == extraKey })

        XCTAssertFalse(editor.isDirty)
        XCTAssertNil(editor.takeSavePayload())
    }

    func testSetToRowSnapshotsPlannedTargetsAndNullsEmptyActuals() throws {
        var editor = handBuilt()
        let key = SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1)
        editor.setValue("185", .weight, at: key)
        let payload = try XCTUnwrap(editor.takeSavePayload())
        let row = payload.setLogs[0]
        XCTAssertEqual(row.eventId, "eid")
        XCTAssertEqual(row.section, "exercise")
        XCTAssertEqual(row.exerciseId, "ub-1")
        XCTAssertEqual(row.exerciseName, "Bench Press")
        XCTAssertEqual(row.setNumber, 1)
        XCTAssertEqual(row.plannedWeight, "185lb")
        XCTAssertEqual(row.plannedReps, "5")
        XCTAssertEqual(row.actualWeight, "185")
        XCTAssertNil(row.actualReps)
        XCTAssertFalse(row.isAutofilled)

        // The wire shape: exactly the allowlisted columns, nulls explicit —
        // `setToRow`'s keys, the metadata on every row and no pitch columns.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(
            String(decoding: try encoder.encode(row), as: UTF8.self),
            #"{"actual_duration":null,"actual_reps":null,"actual_weight":"185","definition_id":"def-bench","event_date":"2026-07-06","event_id":"eid","exercise_id":"ub-1","exercise_name":"Bench Press","is_autofilled":false,"is_warmup":false,"planned_duration":null,"planned_reps":"5","planned_weight":"185lb","rpe":null,"section":"exercise","set_number":1}"#
        )
    }

    func testCardioToRowParsesNumericsAndNullsBlanks() {
        var editor = handBuilt()
        let key = CardioKey(section: "exercise", exerciseId: "run-1")
        editor.setCardio("42.5", .durationMinutes, at: key)
        editor.setCardio("", .distance, at: key)
        editor.setCardio("900 ft", .elevationGain, at: key)
        editor.setCardio("abc", .avgHeartRate, at: key)
        let row = editor.takeSavePayload()!.cardioLogs[0]
        XCTAssertEqual(row.durationMinutes, 42.5)
        XCTAssertNil(row.distance)
        XCTAssertEqual(row.elevationGain, "900 ft")
        XCTAssertNil(row.avgHeartRate)
        XCTAssertEqual(TrackerEditor.leadingDouble("45 min"), 45)
        XCTAssertEqual(TrackerEditor.leadingInt("145 bpm"), 145)
        XCTAssertNil(TrackerEditor.leadingInt(""))
    }

    // MARK: - Finish gate

    func testUntouchedShadowSetsAreSkippedSetsAndZeroFilled() {
        let editor = handBuilt(shadowOnBench: true)
        let rows = editor.collectUntouchedPlanned()
        let bench = rows.filter { $0.exerciseId == "ub-1" }
        XCTAssertEqual(bench.count, 3)
        XCTAssertEqual(bench[0].actualWeight, "0")
        XCTAssertEqual(bench[0].actualReps, "0")
        XCTAssertNil(bench[0].actualDuration)
        XCTAssertTrue(bench[0].isAutofilled)
        // Cardio never zero-fills.
        XCTAssertFalse(rows.contains { $0.exerciseId == "run-1" })
    }

    func testOnlyPristinePlannedSetsZeroFill() throws {
        var editor = handBuilt()
        editor.setValue("5", .reps, at: SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1))
        editor.addExtraSet(section: "exercise", exerciseId: "ub-1")
        let rows = editor.collectUntouchedPlanned()
        // bench sets 2 + 3, the stretch, and the pitch (a planned grade with nothing logged)
        XCTAssertEqual(rows.filter { $0.exerciseId == "ub-1" }.map(\.setNumber).sorted(), [2, 3])
        XCTAssertTrue(rows.allSatisfy(\.isAutofilled))
        let stretch = try XCTUnwrap(rows.first { $0.exerciseId == "ub-cd-1" })
        XCTAssertEqual(stretch.actualDuration, "0")
        XCTAssertNil(stretch.actualWeight)
        XCTAssertNil(stretch.actualReps)
        XCTAssertEqual(editor.unloggedPlannedCount, rows.count)
    }

    func testAlreadyLoggedSetsAreNotZeroFilled() throws {
        let editor = try editor()
        // Set 1 is logged; set 2 is a never-tapped shadow.
        XCTAssertEqual(editor.collectUntouchedPlanned().map(\.setNumber), [2])
    }

    func testRepsIsTheFallbackWhenThePlanNamedNoDimension() {
        let bare = TrackedExercise(
            section: "exercise", exercise: Exercise(id: "x", name: "Burpees"), isCardio: false,
            sets: [TrackedSet(setNumber: 1, planned: PlannedSet(setNumber: 1))]
        )
        let editor = TrackerEditor(groups: [TrackedSectionGroup(section: "exercise", label: "Main", exercises: [bare])],
                                   session: fixtureSession)
        let row = editor.collectUntouchedPlanned()[0]
        XCTAssertEqual(row.actualReps, "0")
        XCTAssertNil(row.actualWeight)
        XCTAssertNil(row.actualDuration)
    }

    // MARK: - Swap

    /// `clearResolvedLoads`: a percentage of the planned lift's max means
    /// nothing for the movement swapped in, and swapping back does not restore it.
    func testSwapClearsResolvedLoads() {
        var editor = handBuilt(resolvedOnBench: "187.5 lb")
        editor.swap(section: "exercise", exerciseId: "ub-1", toName: "Ring Dips", definitionId: "def-dips")
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.sets.map(\.resolvedPlannedWeight), [nil, nil, nil])
        editor.swap(section: "exercise", exerciseId: "ub-1", toName: "Bench Press", definitionId: "def-bench")
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.sets.map(\.resolvedPlannedWeight), [nil, nil, nil])
    }

    func testSwapRelabelsAndRemembersThePlannedMovement() {
        var editor = handBuilt()
        XCTAssertTrue(editor.swap(section: "exercise", exerciseId: "ub-1", toName: "Single-Arm Dumbbell Press", definitionId: "def-db-press"))
        var bench = editor.exercise(section: "exercise", id: "ub-1")!
        XCTAssertEqual(bench.exercise.name, "Single-Arm Dumbbell Press")
        XCTAssertEqual(bench.exercise.definitionId, "def-db-press")
        XCTAssertEqual(bench.substitutedFrom, "Bench Press")
        XCTAssertEqual(bench.exercise.id, "ub-1")
        // The plan is untouched.
        XCTAssertEqual(bench.sets[0].planned?.targetWeight, "185lb")

        // A second swap still names the planned movement; swapping back clears it.
        editor.swap(section: "exercise", exerciseId: "ub-1", toName: "Ring Dips", definitionId: "def-dips")
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.substitutedFrom, "Bench Press")
        editor.swap(section: "exercise", exerciseId: "ub-1", toName: "Bench Press", definitionId: "def-bench")
        bench = editor.exercise(section: "exercise", id: "ub-1")!
        XCTAssertNil(bench.substitutedFrom)

        // Rows serialise with the swapped-in name and definition.
        editor.swap(section: "exercise", exerciseId: "ub-1", toName: "Ring Dips", definitionId: "def-dips")
        editor.setValue("10", .reps, at: SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1))
        let row = editor.takeSavePayload()!.setLogs[0]
        XCTAssertEqual(row.exerciseName, "Ring Dips")
        XCTAssertEqual(row.definitionId, "def-dips")
        XCTAssertEqual(row.exerciseId, "ub-1")
    }

    func testPerSideWarningTruthTable() {
        var editor = handBuilt()
        let unilateral = ExerciseDefinition(id: "def-db-press", canonicalName: "Single-Arm Dumbbell Press", category: "strength", isUnilateral: true)
        let bilateral = ExerciseDefinition(id: "def-dips", canonicalName: "Ring Dips", category: "strength", isUnilateral: false)
        let key = SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1)

        // Not swapped: a planned unilateral entry already states its convention.
        editor.setValue("10", .reps, at: key)
        XCTAssertFalse(editor.needsPerSideWarning(section: "exercise", exerciseId: "ub-1", swappedTo: unilateral))

        editor.swap(section: "exercise", exerciseId: "ub-1", toName: unilateral.canonicalName, definitionId: unilateral.id)
        XCTAssertTrue(editor.needsPerSideWarning(section: "exercise", exerciseId: "ub-1", swappedTo: unilateral))
        XCTAssertFalse(editor.needsPerSideWarning(section: "exercise", exerciseId: "ub-1", swappedTo: bilateral))
        XCTAssertFalse(editor.needsPerSideWarning(section: "exercise", exerciseId: "ub-1", swappedTo: nil))

        editor.setValue("8 each arm", .reps, at: key)
        XCTAssertFalse(editor.needsPerSideWarning(section: "exercise", exerciseId: "ub-1", swappedTo: unilateral))
        editor.setValue("", .reps, at: key)
        XCTAssertFalse(editor.needsPerSideWarning(section: "exercise", exerciseId: "ub-1", swappedTo: unilateral))
    }

    func testHasLoggedDataCountsValuesTypedThisSitting() {
        var editor = handBuilt()
        XCTAssertFalse(editor.hasLoggedData(section: "exercise", exerciseId: "ub-1"))
        editor.setValue("5", .reps, at: SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 2))
        XCTAssertTrue(editor.hasLoggedData(section: "exercise", exerciseId: "ub-1"))
        XCTAssertFalse(editor.hasLoggedData(section: "exercise", exerciseId: "run-1"))
        editor.setCardio("30", .durationMinutes, at: CardioKey(section: "exercise", exerciseId: "run-1"))
        XCTAssertTrue(editor.hasLoggedData(section: "exercise", exerciseId: "run-1"))
    }

    // MARK: - Input fields

    func testInputFieldsVectors() {
        let editor = handBuilt()
        let bench = editor.exercise(section: "exercise", id: "ub-1")!
        XCTAssertEqual(TrackerEditor.inputFields(for: bench, definition: nil), [.weight, .reps])
        let stretch = editor.exercise(section: "warmup", id: "ub-cd-1")!
        XCTAssertEqual(TrackerEditor.inputFields(for: stretch, definition: nil), [.duration])
        // A pitch logs exactly one thing: the grade.
        XCTAssertEqual(TrackerEditor.inputFields(for: editor.exercise(section: "exercise", id: "p-1")!, definition: nil), [.weight])

        // A value already carried surfaces its field regardless of the plan.
        var withTime = stretch
        withTime.sets[0].actualReps = "12"
        XCTAssertEqual(TrackerEditor.inputFields(for: withTime, definition: nil), [.reps, .duration])

        // Swapped onto a loaded movement: weight + reps appear even though the plan had neither.
        var swapped = stretch
        swapped.substitutedFrom = "Doorway Pec Stretch"
        let strength = ExerciseDefinition(id: "d", canonicalName: "DB Press", category: "strength")
        XCTAssertEqual(TrackerEditor.inputFields(for: swapped, definition: strength), [.weight, .reps, .duration])
        let timed = ExerciseDefinition(id: "d2", canonicalName: "Plank", category: "skill", defaultDuration: "60s")
        XCTAssertEqual(TrackerEditor.inputFields(for: swapped, definition: timed), [.duration])
        // Unknown replacement: assume weight + reps.
        XCTAssertEqual(TrackerEditor.inputFields(for: swapped, definition: nil), [.weight, .reps, .duration])

        // Nothing planned, nothing logged: reps.
        let bare = TrackedExercise(section: "exercise", exercise: Exercise(id: "x", name: "Burpees"), isCardio: false,
                                   sets: [TrackedSet(setNumber: 1, planned: PlannedSet(setNumber: 1))])
        XCTAssertEqual(TrackerEditor.inputFields(for: bare, definition: nil), [.reps])
    }

    /// `log_fields` (phase 53): what a movement is always logged in applies on
    /// a planned entry too — the prescription says "3 × 8", the library says
    /// the dips are sometimes weighted, so the weight has somewhere to go.
    func testDefinitionLogFieldsApplyOnPlanAndAddedFieldsShowAtOnce() {
        let editor = handBuilt()
        let stretch = editor.exercise(section: "warmup", id: "ub-cd-1")!
        XCTAssertFalse(stretch.isOffPlan)
        let weighted = ExerciseDefinition(id: "d", canonicalName: "Doorway Pec Stretch", category: "stretch",
                                          defaultWeight: "20 lb", logFields: ["weight"])
        // Only logFields is read on-plan: the default weight alone adds nothing.
        XCTAssertEqual(TrackerEditor.inputFields(for: stretch, definition: ExerciseDefinition(
            id: "d", canonicalName: "Doorway Pec Stretch", category: "strength", defaultWeight: "20 lb")), [.duration])
        XCTAssertEqual(TrackerEditor.inputFields(for: stretch, definition: weighted), [.weight, .duration])
        // A field added this sitting shows before (and without) a definition write.
        XCTAssertEqual(TrackerEditor.inputFields(for: stretch, definition: nil, addedHere: [.reps]), [.reps, .duration])
        // A pitch ignores both: the grade is its one input.
        let pitch = editor.exercise(section: "exercise", id: "p-1")!
        XCTAssertEqual(TrackerEditor.inputFields(for: pitch, definition: weighted, addedHere: [.reps]), [.weight])
        XCTAssertEqual(TrackerEditor.addableFields(for: pitch, fields: [.weight]), [])
        XCTAssertEqual(TrackerEditor.addableFields(for: stretch, fields: [.duration]), [.weight, .reps])
        XCTAssertEqual(TrackerEditor.addableFields(for: stretch, fields: [.weight, .reps, .duration]), [])
        // An unknown name in the column is ignored rather than crashing the card.
        let odd = ExerciseDefinition(id: "d", canonicalName: "X", logFields: ["tempo", "reps"])
        XCTAssertEqual(TrackerEditor.inputFields(for: stretch, definition: odd), [.reps, .duration])
    }

    /// Each queued write carries the stored set plus everything added this
    /// sitting, so a second tap before the first write lands cannot drop it.
    func testNextLogFieldsCarriesEveryFieldAddedThisSitting() {
        XCTAssertEqual(TrackerEditor.nextLogFields(stored: [], addedHere: [], adding: .weight), ["weight"])
        XCTAssertEqual(TrackerEditor.nextLogFields(stored: [], addedHere: [.weight], adding: .duration), ["weight", "duration"])
        XCTAssertEqual(TrackerEditor.nextLogFields(stored: ["duration"], addedHere: [.weight], adding: .reps), ["weight", "reps", "duration"])
        // Idempotent, column-ordered, and a stray stored name is dropped.
        XCTAssertEqual(TrackerEditor.nextLogFields(stored: ["reps", "tempo"], addedHere: [.reps], adding: .reps), ["reps"])
        XCTAssertEqual(SetField(logField: "duration"), .duration)
        XCTAssertNil(SetField(logField: "time"))
        XCTAssertEqual(SetField.allCases.map(\.logField), ["weight", "reps", "duration"])
    }

    func testFieldOrderWalksSetsThenCardioInReadingOrder() {
        let editor = handBuilt()
        let order = editor.fieldOrder { TrackerEditor.inputFields(for: $0, definition: nil) }
        XCTAssertEqual(order.first, .set(SetKey(section: "warmup", exerciseId: "ub-cd-1", setNumber: 1), .duration))
        XCTAssertEqual(order[1], .set(SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1), .weight))
        XCTAssertEqual(order[2], .set(SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1), .reps))
        XCTAssertEqual(order[3], .set(SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 2), .weight))
        XCTAssertEqual(order[7], .cardio(CardioKey(section: "exercise", exerciseId: "run-1"), .durationMinutes))
        XCTAssertEqual(order.last, .set(SetKey(section: "exercise", exerciseId: "p-1", setNumber: 1), .weight))
        XCTAssertEqual(order.count, 1 + 6 + 4 + 1)
    }

    // MARK: - Set metadata (phase55)

    private var bench1: SetKey { SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1) }
    private var pitch1: SetKey { SetKey(section: "exercise", exerciseId: "p-1", setNumber: 1) }

    private func wire(_ row: SetLogRow) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(row), as: UTF8.self)
    }

    func testParseRpeVectors() {
        // plan.test.ts: 1–10, rounded to the half, anything else is no rating.
        XCTAssertEqual(SetMetadata.parseRpe("8"), 8)
        XCTAssertEqual(SetMetadata.parseRpe(" 7.5 "), 7.5)
        XCTAssertEqual(SetMetadata.parseRpe("7.3"), 7.5)
        XCTAssertEqual(SetMetadata.parseRpe("7.2"), 7)
        XCTAssertEqual(SetMetadata.parseRpe("1"), 1)
        XCTAssertEqual(SetMetadata.parseRpe("10"), 10)
        XCTAssertEqual(SetMetadata.parseRpe("7,5"), 7.5, "a comma locale's keypad")
        for bad in ["", "  ", "0", "0.5", "10.5", "11", "-3", "hard", "inf", nil] as [String?] {
            XCTAssertNil(SetMetadata.parseRpe(bad), "\(String(describing: bad))")
        }
        XCTAssertEqual(SetMetadata.normalizeRpeText("8.0"), "8")
        XCTAssertEqual(SetMetadata.normalizeRpeText("7.3"), "7.5")
        XCTAssertEqual(SetMetadata.normalizeRpeText("12"), "")
    }

    func testParseAttemptsVectors() {
        XCTAssertEqual(SetMetadata.parseAttempts("3"), 3)
        XCTAssertEqual(SetMetadata.parseAttempts(" 1 "), 1)
        for bad in ["", "0", "-1", "2.5", "two", nil] as [String?] {
            XCTAssertNil(SetMetadata.parseAttempts(bad), "\(String(describing: bad))")
        }
    }

    func testBoulderingNeverFollows() {
        XCTAssertEqual(SetMetadata.ascentStyles(for: "sport").map(\.value), ["flash", "redpoint", "follow", "attempt"])
        XCTAssertEqual(SetMetadata.ascentStyles(for: "boulder").map(\.value), ["flash", "redpoint", "attempt"])
    }

    func testWarmupAndRpeDirtyTheSetAndRideTheRow() throws {
        var editor = handBuilt()
        XCTAssertTrue(editor.setWarmup(true, at: bench1))
        XCTAssertTrue(editor.setRpe("7.3", at: bench1))
        XCTAssertEqual(editor.dirtySets, [bench1])
        let row = try XCTUnwrap(editor.takeSavePayload()?.setLogs.first)
        XCTAssertTrue(row.isWarmup)
        XCTAssertEqual(row.rpe, 7.5)
        XCTAssertEqual(
            try wire(row),
            #"{"actual_duration":null,"actual_reps":null,"actual_weight":null,"definition_id":"def-bench","event_date":"2026-07-06","event_id":"eid","exercise_id":"ub-1","exercise_name":"Bench Press","is_autofilled":false,"is_warmup":true,"planned_duration":null,"planned_reps":"5","planned_weight":"185lb","rpe":7.5,"section":"exercise","set_number":1}"#
        )
    }

    func testAnUnparseableRpeIsSentAsNoRatingAndSettlesToBlank() throws {
        var editor = handBuilt()
        editor.setRpe("11", at: bench1)
        XCTAssertNil(try XCTUnwrap(editor.takeSavePayload()?.setLogs.first).rpe)
        XCTAssertTrue(editor.settleRpe(at: bench1))
        XCTAssertEqual(editor.set(at: bench1)?.rpe, "")
        editor.setRpe("8.0", at: bench1)
        editor.settleRpe(at: bench1)
        XCTAssertEqual(editor.set(at: bench1)?.rpe, "8")
        XCTAssertFalse(editor.settleRpe(at: bench1), "already settled")
    }

    func testAPitchRowCarriesItsAscentAndOnlyAPitchRow() throws {
        var editor = handBuilt()
        XCTAssertTrue(editor.setAscentStyle("redpoint", at: pitch1))
        editor.stepAttempts(by: 1, at: pitch1)
        editor.stepAttempts(by: 1, at: pitch1)
        let row = try XCTUnwrap(editor.takeSavePayload()?.setLogs.first)
        XCTAssertEqual(row.ascentStyle, "redpoint")
        XCTAssertEqual(row.attempts, 2)
        // Picking a style with the grade empty takes the planned grade.
        XCTAssertEqual(row.actualWeight, "5.10c")
        XCTAssertEqual(
            try wire(row),
            #"{"actual_duration":null,"actual_reps":null,"actual_weight":"5.10c","ascent_style":"redpoint","attempts":2,"definition_id":null,"event_date":"2026-07-06","event_id":"eid","exercise_id":"p-1","exercise_name":"Pitch 1","is_autofilled":false,"is_warmup":false,"planned_duration":null,"planned_reps":null,"planned_weight":"5.10c","rpe":null,"section":"exercise","set_number":1}"#
        )
    }

    func testPickingAStyleNeverOverwritesATypedGrade() throws {
        var editor = handBuilt()
        editor.setValue("5.11a", .weight, at: pitch1)
        editor.setAscentStyle("flash", at: pitch1)
        XCTAssertEqual(editor.set(at: pitch1)?.actualWeight, "5.11a")
        editor.setAscentStyle(nil, at: pitch1)
        XCTAssertNil(try XCTUnwrap(editor.takeSavePayload()?.setLogs.first).ascentStyle)
    }

    func testTheAttemptsStepperCountsFromOneAndBackToNone() {
        var editor = handBuilt()
        XCTAssertFalse(editor.stepAttempts(by: -1, at: pitch1), "nothing to step down from")
        editor.stepAttempts(by: 1, at: pitch1)
        XCTAssertEqual(editor.set(at: pitch1)?.attempts, "1")
        editor.stepAttempts(by: -1, at: pitch1)
        XCTAssertEqual(editor.set(at: pitch1)?.attempts, "", "down from one is none")
    }

    func testAZeroFilledSetIsNeverAWarmupARatingOrASend() {
        var editor = handBuilt()
        editor.setWarmup(true, at: bench1)
        editor.setRpe("9", at: bench1)
        editor.setAscentStyle("attempt", at: pitch1)
        editor.setValue("", .weight, at: pitch1)
        _ = editor.takeSavePayload()
        let rows = editor.collectUntouchedPlanned()
        let bench = rows.first { $0.key == bench1 }
        XCTAssertEqual(bench?.isWarmup, false)
        XCTAssertNil(bench?.rpe)
        let pitch = rows.first { $0.key == pitch1 }
        XCTAssertEqual(pitch?.isPitch, true, "the zero-fill still names its pitch columns, as null")
        XCTAssertNil(pitch?.ascentStyle)
        XCTAssertNil(pitch?.attempts)
    }

    func testAQueuedRowReplaysItsMetadata() throws {
        var editor = handBuilt()
        editor.setWarmup(true, at: bench1)
        editor.setRpe("6.5", at: bench1)
        editor.setAscentStyle("flash", at: pitch1)
        editor.stepAttempts(by: 1, at: pitch1)
        let payload = try XCTUnwrap(editor.takeSavePayload())
        // Round-trip through the queue's storage, then onto a fresh model.
        let stored = try JSONDecoder().decode(SavePayload.self, from: JSONEncoder().encode(payload))
        XCTAssertEqual(stored, payload)
        var fresh = handBuilt()
        fresh.apply(stored)
        XCTAssertEqual(fresh.set(at: bench1)?.isWarmup, true)
        XCTAssertEqual(fresh.set(at: bench1)?.rpe, "6.5")
        XCTAssertEqual(fresh.set(at: pitch1)?.ascentStyle, "flash")
        XCTAssertEqual(fresh.set(at: pitch1)?.attempts, "1")
    }

    func testAReplayedPitchRowForAnUnseenAddedExerciseComesBackAsAPitch() throws {
        var editor = handBuilt()
        let row = SetLogRow(
            eventId: "eid", eventDate: "2026-07-06", section: "exercise", exerciseId: "added-1", exerciseName: "Extra Pitch",
            setNumber: 1, actualWeight: "5.9", isPitch: true, ascentStyle: "flash", attempts: 1
        )
        editor.apply(SavePayload(setLogs: [row]))
        let tracked = try XCTUnwrap(editor.exercise(section: "exercise", id: "added-1"))
        XCTAssertEqual(tracked.exercise.category, "climbing")
        let key = SetKey(section: "exercise", exerciseId: "added-1", setNumber: 1)
        XCTAssertEqual(editor.set(at: key)?.ascentStyle, "flash")
        let resent = TrackerEditor.setToRow(session: editor.session, tracked: tracked, set: try XCTUnwrap(editor.set(at: key)))
        XCTAssertTrue(try wire(resent).contains(#""ascent_style":"flash""#))
    }

    func testARowQueuedBeforeTheMetadataStillDecodes() throws {
        let old = #"{"event_id":"eid","event_date":"2026-07-06","section":"exercise","exercise_id":"ub-1","exercise_name":"Bench Press","definition_id":null,"set_number":1,"planned_weight":null,"planned_reps":null,"planned_duration":null,"actual_weight":"185","actual_reps":"5","actual_duration":null,"is_autofilled":false}"#
        let row = try JSONDecoder().decode(SetLogRow.self, from: Data(old.utf8))
        XCTAssertFalse(row.isWarmup)
        XCTAssertNil(row.rpe)
        XCTAssertFalse(row.isPitch)
    }

    func testFieldOrderPlacesEachRatingAfterItsSet() {
        let editor = handBuilt()
        let order = editor.fieldOrder(rpe: true) { TrackerEditor.inputFields(for: $0, definition: nil) }
        XCTAssertEqual(order[1], .rpe(SetKey(section: "warmup", exerciseId: "ub-cd-1", setNumber: 1)))
        XCTAssertEqual(order[2], .set(bench1, .weight))
        XCTAssertEqual(order[3], .set(bench1, .reps))
        XCTAssertEqual(order[4], .rpe(bench1))
        XCTAssertEqual(order.count, (1 + 1) + 3 * 3 + 4 + (1 + 1))
    }

    // MARK: - Replay and refresh

    func testApplyReplaysAQueuedSaveIncludingARemovedExtra() throws {
        var editor = try editor()
        editor.apply(SavePayload(
            setLogs: [setRow(2, weight: "115 lb", reps: "4"), setRow(4, weight: "90 lb", reps: "8")],
            cardioLogs: [CardioLogRow(eventId: fixtureSession.eventId, eventDate: fixtureSession.eventDate, section: "exercise",
                                      exerciseId: "fx-row", exerciseName: "Fixture Row", durationMinutes: 42.5, avgHeartRate: 145)],
            removedSets: [SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 3)]
        ))
        let press = editor.exercise(section: "exercise", id: "fx-press")!
        XCTAssertEqual(press.sets.map(\.setNumber), [1, 2, 4])
        XCTAssertEqual(press.sets[1].actualWeight, "115 lb")
        XCTAssertTrue(press.sets[1].isLogged)
        XCTAssertNil(press.sets[1].shadow)
        XCTAssertTrue(press.sets[2].isExtra)
        XCTAssertEqual(press.sets[2].actualReps, "8")
        let cardio = editor.exercise(section: "exercise", id: "fx-row")!.cardio!
        XCTAssertEqual(cardio.durationMinutes, "42.5")
        XCTAssertEqual(cardio.avgHeartRate, "145")
        XCTAssertTrue(cardio.isLogged)
        // Replay is not an edit: nothing is dirty afterwards.
        XCTAssertFalse(editor.isDirty)
    }

    func testFreshGroupsReplaceTheCachedOnesOnlyWhenNothingLocalIsAhead() throws {
        var editor = try editor()
        let fresh = handBuilt().groups
        XCTAssertFalse(editor.replaceGroupsIfClean(fresh, queueHasPending: true))
        editor.setValue("1", .reps, at: set1)
        XCTAssertFalse(editor.replaceGroupsIfClean(fresh, queueHasPending: false))
        _ = editor.takeSavePayload()
        XCTAssertTrue(editor.replaceGroupsIfClean(fresh, queueHasPending: false))
        XCTAssertEqual(editor.groups.count, 2)
    }

    // MARK: - Added exercises

    private var pushupSet1: SetKey { SetKey(section: "exercise", exerciseId: "added-1000", setNumber: 1) }

    private func withPushups() -> TrackerEditor {
        var editor = handBuilt()
        editor.addExercise(id: "added-1000", name: "Push-Up", definitionId: "def-pushup", category: "strength", sectionLabel: "Main Work")
        return editor
    }

    func testAddedExerciseIdsSortByTime() {
        XCTAssertEqual(TrackerEditor.addedExerciseId(at: Date(timeIntervalSince1970: 1_700_000_000)), "added-1700000000000")
        XCTAssertTrue(TrackerEditor.isAddedExerciseId("added-1"))
        XCTAssertFalse(TrackerEditor.isAddedExerciseId("ub-1"))
    }

    func testAddingAppendsOneEmptyExtraSetAndIsNotAnEdit() {
        let editor = withPushups()
        let pushups = editor.groups[1].exercises.last
        XCTAssertEqual(pushups?.exercise.name, "Push-Up")
        XCTAssertEqual(pushups?.added, true)
        XCTAssertEqual(pushups?.sets.map(\.isExtra), [true])
        // Nothing persists until a value is typed, like any empty extra set.
        XCTAssertFalse(editor.isDirty)
        XCTAssertTrue(editor.collectUntouchedPlanned().allSatisfy { $0.exerciseId != "added-1000" })
    }

    func testAnAddedSetSavesUnderItsOwnIdAndName() {
        var editor = withPushups()
        editor.setValue("20", .reps, at: pushupSet1)
        let payload = editor.takeSavePayload()
        XCTAssertEqual(payload?.setLogs.first?.exerciseId, "added-1000")
        XCTAssertEqual(payload?.setLogs.first?.exerciseName, "Push-Up")
        XCTAssertEqual(payload?.setLogs.first?.definitionId, "def-pushup")
        XCTAssertNil(payload?.setLogs.first?.plannedReps)
    }

    func testAddingOpensTheMainSectionInPlanOrder() {
        var editor = TrackerEditor(groups: [
            TrackedSectionGroup(section: "warmup", label: "Warm-Up", exercises: []),
            TrackedSectionGroup(section: "cooldown", label: "Cool-Down", exercises: []),
        ], session: SessionKey(eventId: "eid", eventDate: "2026-07-06"))
        editor.addExercise(id: "added-1", name: "Push-Up", definitionId: nil, category: "strength", sectionLabel: "Main Work")
        XCTAssertEqual(editor.groups.map(\.section), ["warmup", "exercise", "cooldown"])
        XCTAssertEqual(editor.groups[1].label, "Main Work")
    }

    func testRemovingTheLastSetRemovesTheAddedExercise() {
        var editor = withPushups()
        editor.setValue("20", .reps, at: pushupSet1)
        XCTAssertTrue(editor.removeExtraSet(at: pushupSet1))
        XCTAssertNil(editor.exercise(section: "exercise", id: "added-1000"))
        XCTAssertEqual(editor.takeSavePayload(), SavePayload(removedSets: [pushupSet1]))
    }

    func testRemovingAnAddedExerciseRemovesEverySetAndNamesACardioRow() {
        var editor = withPushups()
        editor.addExtraSet(section: "exercise", exerciseId: "added-1000")
        editor.setValue("20", .reps, at: pushupSet1)
        XCTAssertTrue(editor.removeAddedExercise(section: "exercise", exerciseId: "added-1000"))
        XCTAssertEqual(editor.takeSavePayload()?.removedSets.map(\.setNumber), [1, 2])

        editor.addExercise(id: "added-2000", name: "Assault Bike", definitionId: "def-bike", category: "cardio", sectionLabel: "Main Work")
        editor.setCardio("10", .durationMinutes, at: CardioKey(section: "exercise", exerciseId: "added-2000"))
        XCTAssertTrue(editor.removeAddedExercise(section: "exercise", exerciseId: "added-2000"))
        let payload = editor.takeSavePayload()
        XCTAssertEqual(payload?.cardioLogs, [])
        XCTAssertEqual(payload?.removedSets, [SetKey(section: "exercise", exerciseId: "added-2000", setNumber: 0)])
        // A planned exercise is not the editor's to remove.
        XCTAssertFalse(editor.removeAddedExercise(section: "exercise", exerciseId: "ub-1"))
    }

    func testAddedExercisesTakeTheirFieldsFromTheDefinition() {
        let editor = withPushups()
        let pushups = editor.exercise(section: "exercise", id: "added-1000")!
        XCTAssertEqual(TrackerEditor.inputFields(for: pushups, definition: nil), [.weight, .reps])
        let plank = ExerciseDefinition(id: "plank", canonicalName: "Plank", aliases: [], category: "mobility", muscleGroups: [], equipment: [], defaultDuration: "60s")
        XCTAssertEqual(TrackerEditor.inputFields(for: pushups, definition: plank), [.duration])
    }

    func testReplayRebuildsAnAddedExerciseTheCacheHasNotSeen() {
        var editor = handBuilt()
        editor.apply(SavePayload(
            setLogs: [SetLogRow(eventId: "eid", eventDate: "2026-07-06", section: "exercise", exerciseId: "added-1000",
                                exerciseName: "Push-Up", definitionId: "def-pushup", setNumber: 1, actualReps: "20")],
            cardioLogs: [CardioLogRow(eventId: "eid", eventDate: "2026-07-06", section: "exercise", exerciseId: "added-2000",
                                      exerciseName: "Assault Bike", definitionId: "def-bike", durationMinutes: 10)]
        ))
        let pushups = editor.exercise(section: "exercise", id: "added-1000")
        XCTAssertEqual(pushups?.added, true)
        XCTAssertEqual(pushups?.sets.first?.actualReps, "20")
        XCTAssertEqual(editor.exercise(section: "exercise", id: "added-2000")?.cardio?.durationMinutes, "10")
        XCTAssertFalse(editor.isDirty)

        editor.apply(SavePayload(removedSets: [
            SetKey(section: "exercise", exerciseId: "added-1000", setNumber: 1),
            SetKey(section: "exercise", exerciseId: "added-2000", setNumber: 0),
        ]))
        XCTAssertNil(editor.exercise(section: "exercise", id: "added-1000"))
        XCTAssertNil(editor.exercise(section: "exercise", id: "added-2000"))
    }

    // MARK: - Voice (W17)

    private var bench2: SetKey { SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 2) }
    private var bench3: SetKey { SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 3) }
    private var bench4: SetKey { SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 4) }

    private func spoken(_ weight: Double? = 225, reps: Int? = 5, sets: Int = 1) -> SpokenIntent {
        .log(sets: sets, values: SpokenValues(weight: weight.map { SpokenWeight(value: $0) }, reps: reps))
    }

    func testClearShadowLeavesTheKeyClean() throws {
        var editor = try editor()
        XCTAssertNotNil(editor.set(at: set2)?.shadow)
        XCTAssertTrue(editor.clearShadow(at: set2))
        XCTAssertNil(editor.set(at: set2)?.shadow)
        XCTAssertEqual(editor.set(at: set2)?.actualWeight, "", "nothing committed")
        XCTAssertFalse(editor.isDirty)
        XCTAssertFalse(editor.clearShadow(at: set2), "nothing left to clear")
        XCTAssertFalse(editor.clearShadow(at: set1), "a row that never had a ghost")
        XCTAssertFalse(editor.clearShadow(at: SetKey(section: "exercise", exerciseId: "nope", setNumber: 1)))
    }

    func testApplySpokenFillsTheFirstEmptyPlannedSetAndClearsItsGhost() throws {
        var editor = handBuilt(shadowOnBench: true)
        let applied = try XCTUnwrap(editor.applySpoken(spoken(), section: "exercise", exerciseId: "ub-1", unit: .lb))
        XCTAssertEqual(applied.keys, [bench1])
        XCTAssertEqual(applied.kind, .planned)
        XCTAssertNotNil(applied.previous[0].shadow, "the row as it was, ghost included")
        let set = try XCTUnwrap(editor.set(at: bench1))
        XCTAssertEqual(set.actualWeight, "225")
        XCTAssertEqual(set.actualReps, "5")
        XCTAssertEqual(set.actualDuration, "", "a field that was not said is not written")
        XCTAssertNil(set.shadow)
        XCTAssertNotNil(editor.set(at: bench2)?.shadow, "the next row keeps its ghost")
        XCTAssertEqual(editor.dirtySets, [bench1])
        XCTAssertEqual(editor.takeSavePayload()?.setLogs.map(\.actualWeight), ["225"], "bare, as typed")

        // The next utterance lands on the next empty row.
        let second = try XCTUnwrap(editor.applySpoken(spoken(230), section: "exercise", exerciseId: "ub-1", unit: .lb))
        XCTAssertEqual(second.keys, [bench2])
        XCTAssertEqual(editor.set(at: bench2)?.actualWeight, "230")
    }

    func testApplySpokenAddsAnExtraWhenNoPlannedRowIsEmpty() throws {
        var editor = handBuilt()
        for n in 1...3 { editor.setValue("5", .reps, at: SetKey(section: "exercise", exerciseId: "ub-1", setNumber: n)) }
        let applied = try XCTUnwrap(editor.applySpoken(spoken(), section: "exercise", exerciseId: "ub-1", unit: .lb))
        XCTAssertEqual(applied.keys, [bench4])
        XCTAssertEqual(applied.kind, .extra)
        XCTAssertEqual(applied.previous[0].isExtra, true)
        XCTAssertEqual(editor.set(at: bench4)?.isExtra, true)
        XCTAssertEqual(editor.set(at: bench4)?.actualWeight, "225")
        XCTAssertTrue(editor.dirtySets.contains(bench4))
    }

    func testApplySpokenSpansSetsAcrossPlannedRowsThenExtras() throws {
        var editor = handBuilt()
        editor.setValue("5", .reps, at: bench1)
        let applied = try XCTUnwrap(editor.applySpoken(spoken(sets: 3), section: "exercise", exerciseId: "ub-1", unit: .lb))
        XCTAssertEqual(applied.keys, [bench2, bench3, bench4])
        XCTAssertEqual(applied.kind, .planned)
        XCTAssertEqual(applied.previous.map(\.isExtra), [false, false, true])
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.sets.map(\.actualWeight), ["", "225", "225", "225"])
        XCTAssertEqual(editor.set(at: bench1)?.actualReps, "5", "a row with actuals is never overwritten")
    }

    func testApplySpokenRepeatCopiesTheLastSetWithActuals() throws {
        var editor = handBuilt()
        XCTAssertNil(editor.applySpoken(.repeat, section: "exercise", exerciseId: "ub-1", unit: .lb), "nothing to repeat yet")
        XCTAssertFalse(editor.isDirty)
        editor.setValue("185", .weight, at: bench1)
        editor.setValue("5", .reps, at: bench1)
        editor.setValue("190", .weight, at: bench2)
        editor.setValue("4", .reps, at: bench2)
        editor.setRpe("9", at: bench2)
        let applied = try XCTUnwrap(editor.applySpoken(.repeat, section: "exercise", exerciseId: "ub-1", unit: .lb))
        XCTAssertEqual(applied.keys, [bench3])
        let set = try XCTUnwrap(editor.set(at: bench3))
        XCTAssertEqual(set.actualWeight, "190")
        XCTAssertEqual(set.actualReps, "4")
        XCTAssertNil(set.rpe, "effort is per set; only the actuals repeat")
    }

    func testApplySpokenRefusesCardioClimbingAndUnknownExercises() {
        var editor = handBuilt()
        XCTAssertNil(editor.applySpoken(spoken(), section: "exercise", exerciseId: "run-1", unit: .lb))
        XCTAssertNil(editor.applySpoken(spoken(), section: "exercise", exerciseId: "p-1", unit: .lb))
        XCTAssertNil(editor.applySpoken(spoken(), section: "exercise", exerciseId: "nope", unit: .lb))
        XCTAssertNil(editor.applySpoken(spoken(), section: "warmup", exerciseId: "ub-1", unit: .lb), "the wrong section is unknown")
        XCTAssertFalse(editor.isDirty)
        XCTAssertEqual(editor, handBuilt())
    }

    func testApplySpokenWritesEveryValueThroughTheFormatter() throws {
        var editor = handBuilt()
        let values = SpokenValues(weight: SpokenWeight(value: 62.5, unit: .kg), reps: 8, durationSeconds: 90, rpe: 8.5, isWarmup: true)
        _ = editor.applySpoken(.log(sets: 1, values: values), section: "exercise", exerciseId: "ub-1", unit: .lb)
        let set = try XCTUnwrap(editor.set(at: bench1))
        XCTAssertEqual(set.actualWeight, "62.5 kg")
        XCTAssertEqual(set.actualReps, "8")
        XCTAssertEqual(set.actualDuration, "1:30")
        XCTAssertEqual(set.rpe, "8.5")
        XCTAssertEqual(set.isWarmup, true)
        let row = try XCTUnwrap(editor.takeSavePayload()?.setLogs.first)
        XCTAssertEqual(row.actualWeight, "62.5 kg")
        XCTAssertEqual(row.actualDuration, "1:30")
        XCTAssertEqual(row.rpe, 8.5)
        XCTAssertTrue(row.isWarmup)
        // The bench now shows a duration column, as the "+ time" chip would have made it.
        XCTAssertEqual(TrackerEditor.inputFields(for: editor.exercise(section: "exercise", id: "ub-1")!, definition: nil), [.weight, .reps, .duration])
    }

    func testRevertOfAnEmptyPriorRowRecordsARemovalAndNeverBoth() throws {
        var editor = handBuilt(shadowOnBench: true)
        let before = try XCTUnwrap(editor.set(at: bench1))
        let applied = try XCTUnwrap(editor.applySpoken(spoken(), section: "exercise", exerciseId: "ub-1", unit: .lb))
        editor.revert(applied)
        XCTAssertEqual(editor.set(at: bench1), before, "verbatim, ghost back")
        XCTAssertFalse(editor.dirtySets.contains(bench1))
        XCTAssertEqual(editor.removedSets, [bench1])
        XCTAssertEqual(editor.takeSavePayload(), SavePayload(removedSets: [bench1]), "the delete, never an upsert too")
        XCTAssertFalse(editor.isDirty)
    }

    func testRevertAfterTheSaveFlushedStillRecordsTheRemoval() throws {
        var editor = handBuilt()
        let applied = try XCTUnwrap(editor.applySpoken(spoken(), section: "exercise", exerciseId: "ub-1", unit: .lb))
        let flushed = try XCTUnwrap(editor.takeSavePayload())
        XCTAssertEqual(flushed.setLogs.map(\.key), [bench1])
        editor.revert(applied)
        XCTAssertEqual(editor.set(at: bench1)?.actualWeight, "")
        XCTAssertEqual(editor.takeSavePayload(), SavePayload(removedSets: [bench1]))
        // Queued behind the unsent upsert, the delete wins (the queue's merge).
        XCTAssertEqual(flushed.merging(SavePayload(removedSets: [bench1])), SavePayload(removedSets: [bench1]))
    }

    func testRevertOfARowWithPriorActualsReDirties() throws {
        var editor = try editor()
        let before = try XCTUnwrap(editor.set(at: set1))
        XCTAssertTrue(before.hasAnyActual)
        // Write over a logged row the way a later apply might (the primitive
        // itself never targets one), then take it back.
        editor.setValue("225", .weight, at: set1)
        editor.setValue("5", .reps, at: set1)
        _ = editor.takeSavePayload()
        editor.revert(VoiceApplied(keys: [set1], previous: [before], kind: .planned))
        XCTAssertEqual(editor.set(at: set1), before)
        XCTAssertEqual(editor.set(at: set1)?.actualWeight, "120 lb")
        XCTAssertEqual(editor.dirtySets, [set1], "the old row is re-sent")
        XCTAssertEqual(editor.removedSets, [])
        XCTAssertEqual(editor.takeSavePayload()?.setLogs.map(\.actualWeight), ["120 lb"])
    }

    func testRevertDropsTheExtraTheApplyCreated() throws {
        var editor = handBuilt()
        for n in 1...3 { editor.setValue("5", .reps, at: SetKey(section: "exercise", exerciseId: "ub-1", setNumber: n)) }
        _ = editor.takeSavePayload()
        let applied = try XCTUnwrap(editor.applySpoken(spoken(sets: 2), section: "exercise", exerciseId: "ub-1", unit: .lb))
        XCTAssertEqual(applied.keys.map(\.setNumber), [4, 5])
        editor.revert(applied)
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.sets.map(\.setNumber), [1, 2, 3], "an empty extra persists nothing")
        XCTAssertEqual(editor.takeSavePayload(), SavePayload(removedSets: [bench4, SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 5)]))
    }

    func testRevertOfAnAddedExerciseRemovesIt() throws {
        var editor = withPushups()
        var applied = try XCTUnwrap(editor.applySpoken(spoken(nil, reps: 20), section: "exercise", exerciseId: "added-1000", unit: .lb))
        XCTAssertEqual(applied.keys, [pushupSet1])
        XCTAssertEqual(applied.kind, .extra)
        XCTAssertEqual(editor.set(at: pushupSet1)?.actualReps, "20")
        applied.kind = .addedExercise(id: "added-1000")
        editor.revert(applied)
        XCTAssertNil(editor.exercise(section: "exercise", id: "added-1000"))
        XCTAssertEqual(editor.takeSavePayload(), SavePayload(removedSets: [pushupSet1]))
    }

    func testCurrentExerciseFallbackOrder() {
        var editor = handBuilt()
        XCTAssertEqual(editor.currentExercise(lastLogged: bench2)?.id, "ub-1", "the last logged key's exercise")
        XCTAssertEqual(editor.currentExercise(lastLogged: nil)?.id, "ub-cd-1", "else the first set-tracked exercise with an empty row")
        XCTAssertEqual(editor.currentExercise(lastLogged: nil)?.section, "warmup")
        let cardio = SetKey(section: "exercise", exerciseId: "run-1", setNumber: 1)
        XCTAssertEqual(editor.currentExercise(lastLogged: cardio)?.id, "ub-cd-1", "a cardio key falls back")
        XCTAssertEqual(editor.currentExercise(lastLogged: SetKey(section: "exercise", exerciseId: "gone", setNumber: 1))?.id, "ub-cd-1")
        editor.setValue("60s", .duration, at: SetKey(section: "warmup", exerciseId: "ub-cd-1", setNumber: 1))
        XCTAssertEqual(editor.currentExercise(lastLogged: nil)?.id, "ub-1")
        for n in 1...3 { editor.setValue("5", .reps, at: SetKey(section: "exercise", exerciseId: "ub-1", setNumber: n)) }
        XCTAssertNil(editor.currentExercise(lastLogged: nil), "a cardio row and a pitch never qualify")
        XCTAssertEqual(editor.currentExercise(lastLogged: pitch1)?.id, nil, "nor as a last key")
        editor.addExtraSet(section: "exercise", exerciseId: "ub-1")
        XCTAssertEqual(editor.currentExercise(lastLogged: nil)?.id, "ub-1", "an empty extra counts")
    }

    /// A planned-row Undo records a removal; replaying that removal on an
    /// offline relaunch must leave the row — planned-empty — not delete it.
    func testReplayOfARemovedPlannedKeyKeepsTheRow() throws {
        var editor = handBuilt(shadowOnBench: true, resolvedOnBench: "187.5 lb")
        editor.apply(SavePayload(setLogs: [SetLogRow(
            eventId: "eid", eventDate: "2026-07-06", section: "exercise", exerciseId: "ub-1", exerciseName: "Bench Press",
            definitionId: "def-bench", setNumber: 1, plannedWeight: "185lb", plannedReps: "5",
            actualWeight: "225", actualReps: "5", rpe: 8, isWarmup: true
        )]))
        XCTAssertEqual(editor.set(at: bench1)?.isLogged, true)
        editor.apply(SavePayload(removedSets: [bench1]))
        let set = try XCTUnwrap(editor.set(at: bench1), "the planned row is still there")
        XCTAssertEqual(set.actualWeight, "")
        XCTAssertEqual(set.actualReps, "")
        XCTAssertFalse(set.isLogged)
        XCTAssertFalse(set.isAutofilled)
        XCTAssertNil(set.rpe)
        XCTAssertNil(set.isWarmup)
        XCTAssertEqual(set.planned?.targetWeight, "185lb")
        XCTAssertEqual(set.resolvedPlannedWeight, "187.5 lb")
        XCTAssertFalse(set.isExtra)
        XCTAssertEqual(editor.exercise(section: "exercise", id: "ub-1")?.sets.count, 3)
        XCTAssertFalse(editor.isDirty, "replay is not an edit")
        // An extra's removal still removes it.
        var fixture = try self.editor()
        fixture.apply(SavePayload(setLogs: [setRow(5)]))
        XCTAssertNotNil(fixture.set(at: SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 5)))
        fixture.apply(SavePayload(removedSets: [SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 5)]))
        XCTAssertNil(fixture.set(at: SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 5)))
    }
}
