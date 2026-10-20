import XCTest
@testable import ApexCore

final class VoiceNumbersTests: XCTestCase {
    private func number(_ text: String, clockAsNumber: Bool = true) -> (Double, Int)? {
        VoiceNumbers.readNumber(VoiceTokens.tokenize(text), at: 0, clockAsNumber: clockAsNumber).map { ($0.value, $0.length) }
    }

    private func duration(_ text: String, clockAsDuration: Bool = false) -> (Int, Int)? {
        VoiceNumbers.readDuration(VoiceTokens.tokenize(text), at: 0, clockAsDuration: clockAsDuration).map { ($0.seconds, $0.length) }
    }

    private func assertNumber(_ text: String, _ value: Double, length: Int, clockAsNumber: Bool = true,
                              file: StaticString = #filePath, line: UInt = #line) {
        guard let (v, l) = number(text, clockAsNumber: clockAsNumber) else { return XCTFail("\(text) read as nothing", file: file, line: line) }
        XCTAssertEqual(v, value, text, file: file, line: line)
        XCTAssertEqual(l, length, "\(text): tokens consumed", file: file, line: line)
    }

    private func assertDuration(_ text: String, _ seconds: Int, length: Int, clockAsDuration: Bool = false,
                                file: StaticString = #filePath, line: UInt = #line) {
        guard let (s, l) = duration(text, clockAsDuration: clockAsDuration) else { return XCTFail("\(text) read as no duration", file: file, line: line) }
        XCTAssertEqual(s, seconds, text, file: file, line: line)
        XCTAssertEqual(l, length, "\(text): tokens consumed", file: file, line: line)
    }

    func testEnglishNumbers() {
        let small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
                     "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]
        for (value, word) in small.enumerated() { assertNumber(word, Double(value), length: 1) }
        assertNumber("twenty five", 25, length: 2)
        assertNumber("ninety nine", 99, length: 2)
        assertNumber("forty", 40, length: 1)
        assertNumber("fourty five", 45, length: 2)
        assertNumber("a hundred", 100, length: 2)
        assertNumber("an hundred", 100, length: 2)
        assertNumber("hundred", 100, length: 1)
        assertNumber("a hundred and five", 105, length: 4)
        assertNumber("two hundred twenty five", 225, length: 4)
        assertNumber("two hundred and twenty five", 225, length: 5)
        assertNumber("three hundred fifteen", 315, length: 3)
        assertNumber("one thousand", 1000, length: 2)
        assertNumber("a thousand", 1000, length: 2)
        assertNumber("two thousand five hundred", 2500, length: 4)
        assertNumber("nine thousand nine hundred ninety nine", 9999, length: 6)
        assertNumber("one thousand five", 1005, length: 3)
    }

    func testGymShorthand() {
        assertNumber("two twenty five", 225, length: 3)
        assertNumber("one thirty five", 135, length: 3)
        assertNumber("three fifteen", 315, length: 2)
        assertNumber("two oh five", 205, length: 3)
        assertNumber("two zero five", 205, length: 3)
        assertNumber("one ten", 110, length: 2)
        assertNumber("two twenty", 220, length: 2)
        assertNumber("five forty", 540, length: 2)
        assertNumber("two twenty five for", 225, length: 3)
    }

    func testWhereANumberStops() {
        assertNumber("five five", 5, length: 1, "two units words never merge")
        assertNumber("twenty thirty", 20, length: 1)
        assertNumber("two twenty thirty", 220, length: 2)
        assertNumber("hundred and", 100, length: 1, "`and` is skipped only before more number")
        assertNumber("a hundred and five reps", 105, length: 4)
        assertNumber("five and 225", 5, length: 1)
        assertNumber("5 and 225", 5, length: 1)
        assertNumber("two hundred hundred", 200, length: 2)
        assertNumber("one thousand thousand", 1000, length: 2)
        XCTAssertNil(number("a five"), "an article counts only before hundred or thousand")
        XCTAssertNil(number("a"))
        XCTAssertNil(number("and five"))
        XCTAssertNil(number("point five"))
        XCTAssertNil(number("oh five"), "oh is a number only inside shorthand")
        XCTAssertNil(number("bench"))
        XCTAssertNil(number(""))
    }

    private func assertNumber(_ text: String, _ value: Double, length: Int, _ note: String,
                              file: StaticString = #filePath, line: UInt = #line) {
        assertNumber(text, value, length: length, file: file, line: line)
    }

    func testFractions() {
        assertNumber("sixty two and a half", 62.5, length: 5)
        assertNumber("eight and a half", 8.5, length: 4)
        assertNumber("five and a quarter", 5.25, length: 4)
        assertNumber("two twenty five point five", 225.5, length: 5)
        assertNumber("62 point 5", 62.5, length: 3)
        assertNumber("one hundred point two five", 100.25, length: 5)
        assertNumber("62.5", 62.5, length: 1)
        assertNumber("62.5 and a half", 62.5, length: 1, "a fraction follows a whole number only")
        assertNumber("5 point", 5, length: 1)
        assertNumber("5 and a", 5, length: 1)
        XCTAssertEqual(VoiceNumbers.readNumber(VoiceTokens.tokenize("eight and a half"), at: 0, clockAsNumber: false)?.isInteger, false)
        XCTAssertEqual(VoiceNumbers.readNumber(VoiceTokens.tokenize("eight"), at: 0, clockAsNumber: false)?.isInteger, true)
    }

    func testHomophonesAndDigitsNeverMerge() {
        for word in ["for", "to", "too", "won", "ate"] { XCTAssertNil(number(word), word) }
        assertNumber("2 25", 2, length: 1)
        assertNumber("225 5", 225, length: 1)
        assertNumber("2 twenty five", 2, length: 1)
        assertNumber("two 25", 2, length: 1)
    }

    func testAClockIsANumberOnlyWhenAskedAndShapedLikeOne() {
        assertNumber("2:25", 225, length: 1)
        assertNumber("1:35", 135, length: 1)
        assertNumber("9:59", 959, length: 1)
        XCTAssertNil(number("2:25", clockAsNumber: false))
        XCTAssertNil(number("0:45"), "a zero minute is never a weight")
        XCTAssertNil(number("2:75"), "sixty seconds or more is no clock")
        XCTAssertNil(number("10:30"), "two minute digits are a duration")
        XCTAssertNil(number("1:05:00"))
    }

    func testDurations() {
        assertDuration("45 seconds", 45, length: 2)
        assertDuration("45s", 45, length: 2)
        assertDuration("30 sec", 30, length: 2)
        assertDuration("2 minutes", 120, length: 2)
        assertDuration("2m", 120, length: 2)
        assertDuration("2 min", 120, length: 2)
        assertDuration("2 minutes 15", 135, length: 3)
        assertDuration("2 minutes 15 seconds", 135, length: 4)
        assertDuration("two minutes thirty", 150, length: 3)
        assertDuration("a minute", 60, length: 2)
        assertDuration("a minute thirty", 90, length: 3)
        assertDuration("a minute 15 seconds", 75, length: 4)
        assertDuration("a minute and a half", 90, length: 5)
        assertDuration("half a minute", 30, length: 3)
        assertDuration("one and a half minutes", 90, length: 5)
        assertDuration("1.5 minutes", 90, length: 2)
        assertDuration("two and a half minutes", 150, length: 5)
        assertDuration("1:30", 90, length: 1, clockAsDuration: true)
        assertDuration("0:45", 45, length: 1)
        assertDuration("10:30", 630, length: 1)
        assertDuration("1:05:00", 3900, length: 1)
        XCTAssertNil(duration("1:30"), "a d:dd clock is a number unless the exercise logs time")
        XCTAssertNil(duration("45"))
        XCTAssertNil(duration("a hundred"))
        XCTAssertNil(duration("minute"))
        XCTAssertNil(duration("45 reps"))
    }

    func testHugeNumbersNeverTrap() {
        let huge = String(repeating: "9", count: 30)
        assertNumber(huge, 1e30, length: 1)
        assertNumber("\(huge) and a half", 1e30, length: 1, "no fraction on a number that big")
        XCTAssertEqual(duration("\(huge) minutes")?.0, 1_000_000_000)
        XCTAssertEqual(duration("\(huge) seconds")?.0, 1_000_000_000)
        let upper = VoiceContext(unit: .lb, session: [VoiceSessionExercise(id: "plank", section: "exercise", name: "Plank", fields: [.duration])],
                                 currentExerciseId: "plank", library: [])
        for text in [huge, "\(huge) reps", "\(huge) sets of 5", "rpe \(huge)", "5 at \(huge)", "\(huge) x 5", "\(huge) for 5", "bw plus \(huge)"] {
            _ = VoiceParser.parse(text, context: upper)
        }
        guard case .log(_, let values) = VoiceParser.parse(huge, context: upper).intent else { return XCTFail("a duration") }
        XCTAssertEqual(values.durationSeconds, 1_000_000_000)
        XCTAssertEqual(VoiceParser.parse("\(huge) reps", context: upper).problems, [.repsNotInteger])
    }

    func testTrailingSecondsBelongToTheDurationOnlyWhenNothingElseClaimsThem() {
        assertDuration("a minute 5 reps", 60, length: 2)
        assertDuration("2 minutes 5 at 225", 120, length: 2)
        assertDuration("2 minutes 90", 120, length: 2, "sixty or more is not seconds")
        assertDuration("a minute thirty please", 90, length: 3)
        assertDuration("2 minutes 1:30", 120, length: 2)
    }

    private func assertDuration(_ text: String, _ seconds: Int, length: Int, _ note: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        assertDuration(text, seconds, length: length, file: file, line: line)
    }
}
