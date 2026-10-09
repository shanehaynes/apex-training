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
}
