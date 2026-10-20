import XCTest
@testable import ApexCore

/// `VoiceStorage` against the fixture's `storage` maps and its own vectors:
/// the text a spoken set stores is the text typing would have stored.
final class VoiceStorageTests: XCTestCase {
    private var upper: VoiceContext!
    private var kg: VoiceContext!

    override func setUpWithError() throws {
        let fixture = try VoiceFixture.load()
        upper = try fixture.context(named: "upper")
        kg = try fixture.context(named: "kg")
    }

    func testEveryCaseStorageMatchesTheFormatter() throws {
        let fixture = try VoiceFixture.load()
        for c in fixture.cases {
            let context = try fixture.context(named: c.context)
            let parse = VoiceParser.parse(alternatives: c.input, context: context)
            guard case .log(_, let values) = parse.intent else {
                XCTAssertTrue(c.storage.isEmpty, "\(c.label): nothing to store")
                continue
            }
            let text = VoiceStorage.text(for: values, unit: context.unit)
            XCTAssertEqual(text.weight, c.storage["weight"], "\(c.label): weight text")
            XCTAssertEqual(text.reps, c.storage["reps"], "\(c.label): reps text")
            XCTAssertEqual(text.duration, c.storage["duration"], "\(c.label): duration text")
            XCTAssertEqual(text.rpe, c.storage["rpe"], "\(c.label): rpe text")
            XCTAssertTrue(Set(c.storage.keys).isSubset(of: ["weight", "reps", "duration", "rpe"]), "\(c.label): storage keys")
            // Every weight written reads back through the web's grammar.
            if let weight = text.weight {
                XCTAssertNotNil(Weight.parse(weight, Weight.Context(unit: .lb, bodyWeightLb: 180)), "\(c.label): '\(weight)' is a weight")
            }
            if let duration = text.duration {
                XCTAssertEqual(DurationBuffer.parseDurationSeconds(duration).map { Int($0) }, values.durationSeconds, "\(c.label): duration round-trips")
            }
        }
    }

    func testWeightForms() {
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 225)), "225")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 62.5)), "62.5")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 225, unit: .lb)), "225 lb")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 62.5, unit: .kg)), "62.5 kg")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(bodyweight: true)), "BW")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 25, bodyweight: true, sign: 1)), "BW+25")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 10, unit: .kg, bodyweight: true, sign: 1)), "BW+10 kg")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 10, bodyweight: true, sign: -1)), "BW-10")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(value: 10, bodyweight: true, sign: 0)), "BW", "a load with no sign is no load")
        XCTAssertEqual(VoiceStorage.weight(SpokenWeight(bodyweight: true, sign: 1)), "BW", "a sign with no load is no load")
        // A bare weight under a kg profile stays bare: the profile unit is implied, as when typed.
        let bare = VoiceStorage.text(for: SpokenValues(weight: SpokenWeight(value: 100)), unit: .kg)
        XCTAssertEqual(bare.weight, "100")
        XCTAssertEqual(Weight.parse(bare.weight, Weight.Context(unit: .kg, bodyWeightLb: nil))?.lb ?? 0, 100 * Weight.lbPerKg, accuracy: 1e-6)
    }

    func testDurationsAndRatings() {
        XCTAssertEqual(VoiceStorage.duration(45), "45s")
        XCTAssertEqual(VoiceStorage.duration(90), "1:30")
        XCTAssertEqual(VoiceStorage.duration(120), "2:00")
        XCTAssertEqual(VoiceStorage.duration(3900), "1:05:00")
        XCTAssertEqual(VoiceStorage.rpe(8), "8")
        XCTAssertEqual(VoiceStorage.rpe(8.5), "8.5")
        XCTAssertEqual(VoiceStorage.rpe(7.3), "7.5", "snapped to the half, as the field settles it")
        XCTAssertNil(VoiceStorage.rpe(12))
        XCTAssertNil(VoiceStorage.rpe(0.5))
        let text = VoiceStorage.text(for: SpokenValues(reps: 5, durationSeconds: 90, rpe: 7.3), unit: .lb)
        XCTAssertEqual(text, VoiceStorage.Text(weight: nil, reps: "5", duration: "1:30", rpe: "7.5"))
        XCTAssertEqual(text[.reps], "5")
        XCTAssertNil(text[.weight])
    }

    /// `for`, `to`, `too`, `won`, `ate` are left to alternative ranking.
    func testHomophonesAreNeverNumbers() {
        for word in ["for", "to", "too", "won", "ate"] {
            XCTAssertNil(VoiceNumbers.readNumber(VoiceTokens.tokenize(word), at: 0, clockAsNumber: true), word)
            let parse = VoiceParser.parse("\(word) 225", context: upper)
            guard case .log(_, let values) = parse.intent else { return XCTFail("\(word) 225 should log a weight") }
            XCTAssertEqual(values.weight?.value, 225, word)
            XCTAssertNil(values.reps, "\(word) never became reps")
        }
        // Between two numbers a homophone is noise, not a value: 5 and 225 stay a bare pair.
        for word in ["to", "too", "won", "ate"] {
            let parse = VoiceParser.parse("5 \(word) 225", context: upper)
            XCTAssertEqual(parse.ignored, [word])
            guard case .log(_, let values) = parse.intent else { return XCTFail("5 \(word) 225 should log") }
            XCTAssertEqual(values.weight?.value, 225, word)
            XCTAssertEqual(values.reps, 5, word)
        }
        XCTAssertEqual(VoiceParser.parse("for 5 at 225", context: upper).ignored, [], "a connective is grammar, not noise")
        XCTAssertEqual(VoiceParser.parse("to 225", context: upper).exercise, .unresolved(phrase: "to"), "a leading plain word is the phrase")
    }

    /// A `d:dd` clock is a number dictation wrote with a colon — unless the
    /// exercise logs a duration; `h:mm:ss` and `0:ss` are always durations.
    func testClockIsANumberOrADurationByHint() {
        func values(_ text: String) -> SpokenValues? {
            if case .log(_, let v) = VoiceParser.parse(text, context: upper).intent { return v }
            return nil
        }
        XCTAssertEqual(values("2:25 for 5")?.weight?.value, 225)
        XCTAssertEqual(values("bench 1:30")?.weight?.value, 130)
        XCTAssertEqual(values("plank 1:30")?.durationSeconds, 90)
        XCTAssertEqual(values("plank 2:25")?.durationSeconds, 145)
        XCTAssertEqual(values("1:30 plank")?.durationSeconds, 90)
        XCTAssertEqual(values("bench 0:45")?.durationSeconds, 45, "a zero minute is never a weight")
        XCTAssertEqual(values("bench 1:05:00")?.durationSeconds, 3900, "hours are always a duration")
        XCTAssertEqual(values("bench 10:30")?.durationSeconds, 630, "two minute digits are never a weight")
        XCTAssertEqual(VoiceStorage.text(for: values("plank 1:30")!, unit: .lb).duration, "1:30")
        XCTAssertEqual(VoiceStorage.text(for: values("2:25 for 5")!, unit: .lb).weight, "225")
    }
}
