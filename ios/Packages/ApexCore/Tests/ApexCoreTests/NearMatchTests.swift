import XCTest
@testable import ApexCore

/// Mirrors the web's 'near-match (did you mean)' table in
/// `src/lib/schedule/__tests__/definitions.test.ts` — keep them in step.
final class NearMatchTests: XCTestCase {
    private let library = [
        ExerciseDefinition(id: "pancake-fold", canonicalName: "Pancake Fold", category: "stretch"),
        ExerciseDefinition(id: "pancake-hold", canonicalName: "Pancake Hold", category: "stretch"),
        ExerciseDefinition(id: "bench-press", canonicalName: "Bench Press", category: "strength"),
        ExerciseDefinition(id: "pull-up", canonicalName: "Pull-Up", category: "strength"),
        ExerciseDefinition(id: "rdl", canonicalName: "Romanian Deadlift", aliases: ["Stiff-Leg Deadlift"], category: "strength"),
        ExerciseDefinition(id: "row", canonicalName: "Row", category: "cardio"),
    ]

    private func near(_ query: String) -> [String] {
        NearMatch.definitions(for: query, in: library).map(\.id)
    }

    func testCountsAnAdjacentSwapAsOneEdit() {
        XCTAssertEqual(NearMatch.distance("pnacake", "pancake"), 1)
        XCTAssertEqual(NearMatch.distance("kitten", "sitting"), 3)
        XCTAssertEqual(NearMatch.distance("", "abc"), 3)
    }

    func testFindsTheNameATypoWasReachingForClosestFirst() {
        XCTAssertEqual(near("Pnacake Fold"), ["pancake-fold", "pancake-hold"])
        XCTAssertEqual(near("bnech pres"), ["bench-press"])
        XCTAssertEqual(near("Stif Leg Deadlfit"), ["rdl"])
    }

    func testMatchesAHalfTypedNameOnItsOpening() {
        XCTAssertEqual(near("Pnacake"), ["pancake-fold", "pancake-hold"])
    }

    func testIgnoresPunctuationSoPullupIsNotANewMovement() {
        XCTAssertEqual(near("pullup"), ["pull-up"])
    }

    func testStaysQuietForShortQueriesAndGenuinelyNewNames() {
        XCTAssertEqual(near("rdl"), [])
        XCTAssertEqual(near("Hip Airplane"), [])
        XCTAssertEqual(near("Copenhagen Plank"), [])
    }

    func testRespectsTheLimit() {
        XCTAssertEqual(NearMatch.definitions(for: "Pnacake", in: library, limit: 1).map(\.id), ["pancake-fold"])
    }

    /// W17: the voice resolver's near tier gives a session name the same typo
    /// budget the picker gives a library name, on the spoken key's length.
    func testSessionNamesGetThePickersBudget() {
        let context = VoiceContext(
            unit: .lb,
            session: [VoiceSessionExercise(id: "squat", section: "exercise", name: "Back Squat", fields: [.weight, .reps])],
            currentExerciseId: nil, library: []
        )
        func near(_ phrase: String) -> Int? {
            if case .needsConfirmation(_, let candidates) = VoiceExercise.resolveExercisePhrase(phrase, context: context),
               candidates.first?.match == .near { return candidates.first?.distance }
            return nil
        }
        let key = VoiceExercise.voiceKey("Back Squat")
        for (phrase, budget) in [("sqt", 0), ("sqat", 1), ("back squad", 2), ("back squatting", 3)] {
            XCTAssertEqual(NearMatch.budget(VoiceExercise.voiceKey(phrase).count), budget, phrase)
        }
        XCTAssertEqual(NearMatch.distance("back squad", key), 1)
        XCTAssertEqual(near("back squad"), 1, "one edit inside a budget of two")
        XCTAssertEqual(NearMatch.distance("bak squad", key), 2)
        XCTAssertEqual(near("bak squad"), 2, "two edits, still inside")
        XCTAssertEqual(NearMatch.distance("bak sqad", key), 3)
        XCTAssertNil(near("bak sqad"), "three edits on an eight-letter key is past its budget of two")
        XCTAssertEqual(NearMatch.distance("sqt", "squat"), 2)
        XCTAssertNil(near("sqt"), "three letters have no budget at all")
    }
}
