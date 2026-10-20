import XCTest
@testable import ApexCore

/// Alternative ranking: the score orders parses the way a lifter would.
final class VoiceScoreTests: XCTestCase {
    private var upper: VoiceContext!

    override func setUpWithError() throws {
        upper = try VoiceFixture.load().context(named: "upper")
    }

    private func score(_ text: String) -> Int { VoiceParser.parse(text, context: upper).score }

    func testOkBeatsEmptyBeatsInvalid() {
        XCTAssertGreaterThan(score("5 at 225"), score("bench press"))
        XCTAssertGreaterThan(score("bench press"), score("225 185"))
        XCTAssertGreaterThan(score("okay um"), score("225 185"))
        XCTAssertEqual(VoiceParser.parse("okay um", context: upper).score, 20, "empty on the current exercise")
    }

    func testResolvedBeatsCurrentBeatsConfirmBeatsUnresolved() {
        XCTAssertGreaterThan(score("bench 5 at 225"), score("5 at 225"))
        XCTAssertGreaterThan(score("5 at 225"), score("curls 5 at 225"))
        XCTAssertGreaterThan(score("curls 5 at 225"), score("zercher 5 at 225"))
        XCTAssertEqual(VoiceParser.parse("zercher 5 at 225", context: upper).exercise, .unresolved(phrase: "zercher"))
    }

    func testMoreValuesScoreHigherAndNoiseCosts() {
        XCTAssertGreaterThan(score("5 at 225 rpe 8"), score("5 at 225"))
        XCTAssertGreaterThan(score("5 at 225"), score("225"))
        XCTAssertEqual(score("warm up 5 at 225"), score("5 at 225") + 2)
        XCTAssertEqual(score("3 x 5 at 225"), score("5 at 225") + 2)
        XCTAssertEqual(score("again"), 100 + 20 + 20, "ok, repeat, current")
        let noisy = VoiceParser.parse("5 zzz at 225", context: upper)
        XCTAssertEqual(noisy.ignored, ["zzz"])
        XCTAssertEqual(noisy.score, score("5 at 225") - 5)
        XCTAssertEqual(score("10 20"), score("10 at 20") - 3, "a soft problem costs three")
    }

    func testImplausibleValuesCost() {
        XCTAssertEqual(score("5 at 2250"), score("5 at 225") - 20, "over 1500 lb")
        XCTAssertEqual(score("5 at 700 kilos"), score("5 at 650 kilos"), "700 kg is the kg ceiling")
        XCTAssertEqual(score("5 at 701 kilos"), score("5 at 650 kilos") - 20)
        XCTAssertEqual(score("55 at 225"), score("5 at 225") - 20, "over 50 reps")
        XCTAssertEqual(score("plank 61 minutes"), score("plank 60 minutes") - 10, "over an hour")
        var kg = upper!
        kg.unit = .kg
        XCTAssertEqual(VoiceParser.parse("5 at 701", context: kg).score, VoiceParser.parse("5 at 700", context: kg).score - 20,
                       "a bare weight is read in the profile unit")
    }

    func testTheBestAlternativeWinsAndTiesKeepEngineOrder() {
        let tie = VoiceParser.parse(alternatives: ["5 at 225", "five at 225"], context: upper)
        XCTAssertEqual(tie.chosen, 0)
        XCTAssertEqual(tie.transcript, "5 at 225")
        let later = VoiceParser.parse(alternatives: ["okay um", "5 at 225", "5 at 225 rpe 8"], context: upper)
        XCTAssertEqual(later.chosen, 2)
        XCTAssertEqual(later.transcript, "5 at 225 rpe 8")
        let none = VoiceParser.parse(alternatives: [], context: upper)
        XCTAssertEqual(none.status, .empty)
        XCTAssertEqual(none.chosen, 0)
        XCTAssertEqual(none.transcript, "")
        XCTAssertEqual(none.exercise, .current)
        let single = VoiceParser.parse("5 at 225", context: upper)
        XCTAssertEqual(single.chosen, 0)
        XCTAssertEqual(single, VoiceParser.parse(alternatives: ["5 at 225"], context: upper))
    }
}
