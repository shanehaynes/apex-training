import XCTest
@testable import ApexCore

/// `VoiceExercise`: keys, and each resolution tier in isolation.
final class VoiceExerciseTests: XCTestCase {
    private func context(session: [(String, String)], library: [ExerciseDefinition] = [], current: String? = nil) -> VoiceContext {
        VoiceContext(
            unit: .lb,
            session: session.map { VoiceSessionExercise(id: $0.0, section: "exercise", name: $0.1, definitionId: "def-" + $0.0, fields: [.weight, .reps]) },
            currentExerciseId: current, library: library
        )
    }

    private func resolve(_ phrase: String, _ context: VoiceContext) -> SpokenExercise {
        VoiceExercise.resolveExercisePhrase(phrase, context: context)
    }

    func testKeysDropPunctuationPluralsAndExpandShorthand() {
        XCTAssertEqual(VoiceExercise.voiceWords("Weighted Pull-Ups"), ["weighted", "pull", "ups"])
        XCTAssertEqual(VoiceExercise.voiceKey("Weighted Pull-Ups"), "weighted pull up")
        XCTAssertEqual(VoiceExercise.voiceKey("pull ups"), "pull up")
        XCTAssertEqual(VoiceExercise.voiceKey("Hammer Curls"), "hammer curl")
        XCTAssertEqual(VoiceExercise.voiceKey("Bench Press"), "bench press", "ss is not a plural")
        XCTAssertEqual(VoiceExercise.voiceKey("Flies"), "fly")
        XCTAssertEqual(VoiceExercise.voiceKey("Squats"), "squat")
        XCTAssertEqual(VoiceExercise.voiceKey("Abs"), "abs", "three letters keep their s, joined or not")
        XCTAssertEqual(VoiceExercise.voiceKey("Ring Dips"), "ring dip")
        XCTAssertEqual(VoiceExercise.voiceKey("chin ups"), "chin up", "already spelled out, not expanded twice")
        XCTAssertEqual(VoiceExercise.voiceKey("RDLs"), "romanian deadlift")
        XCTAssertEqual(VoiceExercise.voiceKey("rdl"), "romanian deadlift")
        XCTAssertEqual(VoiceExercise.voiceKey("DB Curl"), "dumbbell curl")
        XCTAssertEqual(VoiceExercise.voiceKey("bb row"), "barbell row")
        XCTAssertEqual(VoiceExercise.voiceKey("KB swings"), "kettlebell swing")
        XCTAssertEqual(VoiceExercise.voiceKey("ohp"), "overhead press")
        XCTAssertEqual(VoiceExercise.voiceKey("dl"), "deadlift")
        XCTAssertEqual(VoiceExercise.voiceKey("sldl"), "stiff leg deadlift")
        XCTAssertEqual(VoiceExercise.voiceKey("chins"), "chin up")
        XCTAssertEqual(VoiceExercise.voiceKey("Chin-Up"), "chin up")
        XCTAssertEqual(VoiceExercise.voiceKey("Lat Pulldown (Close Grip)"), "lat pulldown close grip")
        XCTAssertEqual(VoiceExercise.withoutParenthetical("Lat Pulldown (Close Grip)"), "Lat Pulldown")
        XCTAssertNil(VoiceExercise.withoutParenthetical("Lat Pulldown"))
        XCTAssertNil(VoiceExercise.withoutParenthetical("(Close Grip)"), "nothing left is no key")
        XCTAssertEqual(VoiceExercise.voiceWords("  Back   Squat! "), ["back", "squat"])
        XCTAssertEqual(VoiceExercise.voiceKey(""), "")
    }

    func testExactSessionWinsOverEverything() {
        let library = [ExerciseDefinition(id: "def-hammer", canonicalName: "Hammer Curl", aliases: ["Hammer Curls"]),
                       ExerciseDefinition(id: "lib-curl", canonicalName: "Hammer Curl")]
        let ctx = context(session: [("hammer", "Hammer Curl"), ("dbcurl", "Dumbbell Curl")], library: library)
        XCTAssertEqual(resolve("hammer curl", ctx), .resolved(scope: .session, id: "hammer", name: "Hammer Curl", match: .exact))
        XCTAssertEqual(resolve("hammer curls", ctx), .resolved(scope: .session, id: "hammer", name: "Hammer Curl", match: .exact), "the alias")
        XCTAssertEqual(resolve("Hammer-Curl!", ctx), .resolved(scope: .session, id: "hammer", name: "Hammer Curl", match: .exact))
    }

    func testSeveralExactSessionHitsAsk() {
        var ctx = context(session: [("warm-bench", "Bench Press"), ("main-bench", "Bench Press")])
        ctx.session[0].section = "warmup"
        XCTAssertEqual(resolve("bench press", ctx), .needsConfirmation(phrase: "bench press", candidates: [
            SpokenExercise.Candidate(scope: .session, id: "warm-bench", name: "Bench Press", match: .exact, distance: 0),
            SpokenExercise.Candidate(scope: .session, id: "main-bench", name: "Bench Press", match: .exact, distance: 0),
        ]))
    }

    func testContainedInOneSessionNameIsAppliedInSeveralAsks() {
        let ctx = context(session: [("squat", "Back Squat"), ("bench", "Bench Press"), ("pullups", "Weighted Pull-Ups")])
        XCTAssertEqual(resolve("squat", ctx), .resolved(scope: .session, id: "squat", name: "Back Squat", match: .contained))
        XCTAssertEqual(resolve("squats", ctx), .resolved(scope: .session, id: "squat", name: "Back Squat", match: .contained))
        XCTAssertEqual(resolve("pull ups", ctx), .resolved(scope: .session, id: "pullups", name: "Weighted Pull-Ups", match: .contained))
        XCTAssertEqual(resolve("pull up", ctx), .resolved(scope: .session, id: "pullups", name: "Weighted Pull-Ups", match: .contained),
                       "a three-letter plural is forgiven in containment")
        XCTAssertEqual(resolve("squat press", ctx), .unresolved(phrase: "squat press"), "every phrase word must be in one name")
        let two = context(session: [("hammer", "Hammer Curl"), ("dbcurl", "Dumbbell Curl")])
        XCTAssertEqual(resolve("curl", two), .needsConfirmation(phrase: "curl", candidates: [
            SpokenExercise.Candidate(scope: .session, id: "hammer", name: "Hammer Curl", match: .contained, distance: 0),
            SpokenExercise.Candidate(scope: .session, id: "dbcurl", name: "Dumbbell Curl", match: .contained, distance: 0),
        ]))
    }

    func testNearSessionNamesAskByDistanceThenSessionOrder() {
        let ctx = context(session: [("hack", "Hack Squat"), ("back", "Back Squat")])
        XCTAssertEqual(resolve("back squad", ctx), .needsConfirmation(phrase: "back squad", candidates: [
            SpokenExercise.Candidate(scope: .session, id: "back", name: "Back Squat", match: .near, distance: 1),
            SpokenExercise.Candidate(scope: .session, id: "hack", name: "Hack Squat", match: .near, distance: 2),
        ]))
        XCTAssertEqual(resolve("sqt", ctx), .unresolved(phrase: "sqt"), "three letters have no typo budget")
        XCTAssertEqual(resolve("deadlift", ctx), .unresolved(phrase: "deadlift"))
    }

    func testLibraryTiers() {
        let library = [
            ExerciseDefinition(id: "rdl", canonicalName: "Romanian Deadlift", aliases: ["Stiff-Leg Deadlift"]),
            ExerciseDefinition(id: "lat", canonicalName: "Lat Pulldown"),
            ExerciseDefinition(id: "lat-close", canonicalName: "Lat Pulldown (Close Grip)"),
            ExerciseDefinition(id: "ring-dips", canonicalName: "Ring Dips"),
            ExerciseDefinition(id: "bar-dips", canonicalName: "Bar Dips"),
            ExerciseDefinition(id: "dip-machine", canonicalName: "Dip Machine"),
            ExerciseDefinition(id: "weighted-dips", canonicalName: "Weighted Dips"),
            ExerciseDefinition(id: "incline", canonicalName: "Incline Press", archivedAt: "2026-01-01T00:00:00Z"),
            ExerciseDefinition(id: "run", canonicalName: "Easy Run", category: "cardio"),
            ExerciseDefinition(id: "pitch", canonicalName: "Sport Pitch", category: "climbing"),
        ]
        let ctx = context(session: [("bench", "Bench Press")], library: library)
        XCTAssertEqual(resolve("romanian deadlift", ctx), .resolved(scope: .library, id: "rdl", name: "Romanian Deadlift", match: .exact))
        XCTAssertEqual(resolve("stiff leg deadlifts", ctx), .resolved(scope: .library, id: "rdl", name: "Romanian Deadlift", match: .exact), "the alias")
        XCTAssertEqual(resolve("rdls", ctx), .resolved(scope: .library, id: "rdl", name: "Romanian Deadlift", match: .exact))
        XCTAssertEqual(resolve("lat pulldown", ctx), .needsConfirmation(phrase: "lat pulldown", candidates: [
            SpokenExercise.Candidate(scope: .library, id: "lat", name: "Lat Pulldown", match: .exact, distance: 0),
            SpokenExercise.Candidate(scope: .library, id: "lat-close", name: "Lat Pulldown (Close Grip)", match: .exact, distance: 0),
        ]), "the parenthetical makes a second exact key")
        XCTAssertEqual(resolve("lat pulldown close grip", ctx), .resolved(scope: .library, id: "lat-close", name: "Lat Pulldown (Close Grip)", match: .exact))
        XCTAssertEqual(resolve("dips", ctx), .needsConfirmation(phrase: "dips", candidates: [
            SpokenExercise.Candidate(scope: .library, id: "ring-dips", name: "Ring Dips", match: .contained, distance: 0),
            SpokenExercise.Candidate(scope: .library, id: "bar-dips", name: "Bar Dips", match: .contained, distance: 0),
            SpokenExercise.Candidate(scope: .library, id: "dip-machine", name: "Dip Machine", match: .contained, distance: 0),
        ]), "at most three, in library order")
        XCTAssertEqual(resolve("ring dipz", ctx), .needsConfirmation(phrase: "ring dipz", candidates: [
            SpokenExercise.Candidate(scope: .library, id: "ring-dips", name: "Ring Dips", match: .near, distance: 1),
        ]))
        XCTAssertEqual(resolve("incline press", ctx), .unresolved(phrase: "incline press"), "archived names are not offered")
        XCTAssertEqual(resolve("easy run", ctx), .unresolved(phrase: "easy run"), "cardio cannot take a spoken set")
        XCTAssertEqual(resolve("sport pitch", ctx), .unresolved(phrase: "sport pitch"), "nor can a pitch")
        XCTAssertEqual(resolve("run", ctx), .unresolved(phrase: "run"))
    }

    func testContainedLibraryComesBeforeNearLibraryWithoutRepeating() {
        let library = [
            ExerciseDefinition(id: "ring-dip", canonicalName: "Ring Dip"),
            ExerciseDefinition(id: "ring-row", canonicalName: "Ring Row"),
        ]
        let ctx = context(session: [], library: library)
        // "ring dip" is exact for Ring Dip; "ring dips" is exact too (key "ring dip").
        XCTAssertEqual(resolve("ring dips", ctx), .resolved(scope: .library, id: "ring-dip", name: "Ring Dip", match: .exact))
        // "ring" is contained in both; neither is repeated as near.
        XCTAssertEqual(resolve("ring", ctx), .needsConfirmation(phrase: "ring", candidates: [
            SpokenExercise.Candidate(scope: .library, id: "ring-dip", name: "Ring Dip", match: .contained, distance: 0),
            SpokenExercise.Candidate(scope: .library, id: "ring-row", name: "Ring Row", match: .contained, distance: 0),
        ]))
    }

    func testASessionNameResolvesWithoutItsDefinition() {
        let ctx = context(session: [("x", "Zercher Squat")])
        XCTAssertEqual(resolve("zercher squat", ctx), .resolved(scope: .session, id: "x", name: "Zercher Squat", match: .exact))
    }

    func testNoPhraseMeansTheCurrentExercise() {
        let ctx = context(session: [("bench", "Bench Press")], current: "bench")
        XCTAssertEqual(resolve("", ctx), .current)
        XCTAssertEqual(resolve("   ", ctx), .current)
        XCTAssertEqual(VoiceParser.parse("225 for 5", context: ctx).exercise, .current)
        XCTAssertEqual(VoiceParser.parse("okay um 225 for 5 please", context: ctx).exercise, .current)
        XCTAssertEqual(VoiceParser.parse("225 for 5 on bench", context: ctx).exercise,
                       .resolved(scope: .session, id: "bench", name: "Bench Press", match: .contained), "a trailing name counts")
        XCTAssertEqual(VoiceParser.parse("225 for 5 for the bench press", context: ctx).exercise,
                       .resolved(scope: .session, id: "bench", name: "Bench Press", match: .exact))
        XCTAssertEqual(VoiceParser.parse("just log bench 225 for 5", context: ctx).exercise,
                       .resolved(scope: .session, id: "bench", name: "Bench Press", match: .contained), "fillers drop out of the phrase")
        XCTAssertEqual(VoiceParser.parse("chin ups 8", context: ctx).exercise, .unresolved(phrase: "chin ups"), "up alone is no keyword")
        XCTAssertEqual(VoiceParser.parse("warm up 5 at 135", context: ctx).exercise, .current)
    }
}
