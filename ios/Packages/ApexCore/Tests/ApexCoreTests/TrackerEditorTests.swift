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
    private func handBuilt(shadowOnBench: Bool = false) -> TrackerEditor {
        let bench = TrackedExercise(
            section: "exercise",
            exercise: Exercise(id: "ub-1", name: "Bench Press", category: "strength", definitionId: "def-bench"),
            isCardio: false,
            sets: (1...3).map {
                TrackedSet(
                    setNumber: $0, planned: PlannedSet(setNumber: $0, targetWeight: "185lb", targetReps: "5"),
                    shadow: shadowOnBench ? ShadowValues(weight: "200", reps: "5", duration: "") : nil
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

        // The wire shape: exactly the allowlisted columns, nulls explicit.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(
            String(decoding: try encoder.encode(row), as: UTF8.self),
            #"{"actual_duration":null,"actual_reps":null,"actual_weight":"185","definition_id":"def-bench","event_date":"2026-07-06","event_id":"eid","exercise_id":"ub-1","exercise_name":"Bench Press","is_autofilled":false,"planned_duration":null,"planned_reps":"5","planned_weight":"185lb","section":"exercise","set_number":1}"#
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
        XCTAssertEqual(TrackerEditor.inputFields(for: bench, swappedTo: nil), [.weight, .reps])
        let stretch = editor.exercise(section: "warmup", id: "ub-cd-1")!
        XCTAssertEqual(TrackerEditor.inputFields(for: stretch, swappedTo: nil), [.duration])
        // A pitch logs exactly one thing: the grade.
        XCTAssertEqual(TrackerEditor.inputFields(for: editor.exercise(section: "exercise", id: "p-1")!, swappedTo: nil), [.weight])

        // A value already carried surfaces its field regardless of the plan.
        var withTime = stretch
        withTime.sets[0].actualReps = "12"
        XCTAssertEqual(TrackerEditor.inputFields(for: withTime, swappedTo: nil), [.reps, .duration])

        // Swapped onto a loaded movement: weight + reps appear even though the plan had neither.
        var swapped = stretch
        swapped.substitutedFrom = "Doorway Pec Stretch"
        let strength = ExerciseDefinition(id: "d", canonicalName: "DB Press", category: "strength")
        XCTAssertEqual(TrackerEditor.inputFields(for: swapped, swappedTo: strength), [.weight, .reps, .duration])
        let timed = ExerciseDefinition(id: "d2", canonicalName: "Plank", category: "skill", defaultDuration: "60s")
        XCTAssertEqual(TrackerEditor.inputFields(for: swapped, swappedTo: timed), [.duration])
        // Unknown replacement: assume weight + reps.
        XCTAssertEqual(TrackerEditor.inputFields(for: swapped, swappedTo: nil), [.weight, .reps, .duration])

        // Nothing planned, nothing logged: reps.
        let bare = TrackedExercise(section: "exercise", exercise: Exercise(id: "x", name: "Burpees"), isCardio: false,
                                   sets: [TrackedSet(setNumber: 1, planned: PlannedSet(setNumber: 1))])
        XCTAssertEqual(TrackerEditor.inputFields(for: bare, swappedTo: nil), [.reps])
    }

    func testFieldOrderWalksSetsThenCardioInReadingOrder() {
        let editor = handBuilt()
        let order = editor.fieldOrder { TrackerEditor.inputFields(for: $0, swappedTo: nil) }
        XCTAssertEqual(order.first, .set(SetKey(section: "warmup", exerciseId: "ub-cd-1", setNumber: 1), .duration))
        XCTAssertEqual(order[1], .set(SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1), .weight))
        XCTAssertEqual(order[2], .set(SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 1), .reps))
        XCTAssertEqual(order[3], .set(SetKey(section: "exercise", exerciseId: "ub-1", setNumber: 2), .weight))
        XCTAssertEqual(order[7], .cardio(CardioKey(section: "exercise", exerciseId: "run-1"), .durationMinutes))
        XCTAssertEqual(order.last, .set(SetKey(section: "exercise", exerciseId: "p-1", setNumber: 1), .weight))
        XCTAssertEqual(order.count, 1 + 6 + 4 + 1)
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
}
