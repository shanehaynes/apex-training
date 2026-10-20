import XCTest
@testable import ApexCore

final class VoiceTokensTests: XCTestCase {
    private func texts(_ s: String) -> [String] { VoiceTokens.tokenize(s).map(\.text) }
    private func kinds(_ s: String) -> [VoiceToken.Kind] { VoiceTokens.tokenize(s).map(\.kind) }

    func testSymbolsBecomeWords() {
        XCTAssertEqual(texts("225×5"), ["225", "x", "5"])
        XCTAssertEqual(texts("5@225"), ["5", "at", "225"])
        XCTAssertEqual(texts("bw+25"), ["bw", "plus", "25"])
        XCTAssertEqual(texts("225#"), ["225", "lb"])
        XCTAssertEqual(texts("Bench Press 225"), ["bench", "press", "225"])
    }

    func testAnXBetweenDigitsSplits() {
        XCTAssertEqual(texts("5x5"), ["5", "x", "5"])
        XCTAssertEqual(texts("225x5"), ["225", "x", "5"])
        XCTAssertEqual(texts("5 x 5"), ["5", "x", "5"])
        XCTAssertEqual(texts("3X8"), ["3", "x", "8"])
        XCTAssertEqual(texts("exercise 5"), ["exercise", "5"], "an x inside a word stays")
        XCTAssertEqual(texts("5x"), ["5", "x"], "glued to one side it is a word, not a split")
    }

    func testGluedUnitsSplitOffAndSingleLettersCountOnlyGlued() {
        XCTAssertEqual(texts("225lbs"), ["225", "lbs"])
        XCTAssertEqual(texts("45s"), ["45", "seconds"])
        XCTAssertEqual(texts("2m"), ["2", "minutes"])
        XCTAssertEqual(texts("100k"), ["100", "kg"])
        XCTAssertEqual(texts("100kg"), ["100", "kg"])
        XCTAssertEqual(texts("8reps"), ["8", "reps"])
        XCTAssertEqual(texts("45 s"), ["45", "s"], "a free-standing s is a word, not seconds")
        XCTAssertEqual(kinds("45 s"), [.number(45), .word])
        XCTAssertEqual(texts("1st"), ["1", "st"])
        XCTAssertEqual(kinds("5lb5"), [.word], "digits after the letters make it no number")
    }

    func testApostrophesVanishAndHyphensSeparate() {
        XCTAssertEqual(texts("I'm doin' pull-ups"), ["im", "doin", "pull", "ups"])
        XCTAssertEqual(texts("pull–ups and chin—ups"), ["pull", "ups", "and", "chin", "ups"])
        XCTAssertEqual(texts("don’t"), ["dont"])
    }

    func testCommasFollowTheWeightRule() {
        XCTAssertEqual(kinds("62,5"), [.number(62.5)])
        XCTAssertEqual(kinds("1,200"), [.number(1200)])
        XCTAssertEqual(kinds("1,20"), [.number(1.2)])
        XCTAssertEqual(texts("5, 225"), ["5", "225"])
        XCTAssertEqual(texts("bench, 225"), ["bench", "225"])
        XCTAssertEqual(kinds("62.5"), [.number(62.5)])
    }

    func testTrailingPunctuationIsStripped() {
        XCTAssertEqual(kinds("225."), [.number(225)])
        XCTAssertEqual(texts("again!"), ["again"])
        XCTAssertEqual(texts("5?"), ["5"])
        XCTAssertEqual(texts("ok..."), ["ok"])
        XCTAssertEqual(texts("..."), [])
    }

    func testClocks() {
        XCTAssertEqual(kinds("2:25"), [.clock(first: 2, second: 25, third: nil)])
        XCTAssertEqual(kinds("1:05:00"), [.clock(first: 1, second: 5, third: 0)])
        XCTAssertEqual(kinds("10:30"), [.clock(first: 10, second: 30, third: nil)])
        XCTAssertEqual(kinds("2:5"), [.clock(first: 2, second: 5, third: nil)])
        XCTAssertEqual(kinds("2:255"), [.word])
        XCTAssertEqual(kinds("2:"), [.word])
        XCTAssertEqual(kinds(":30"), [.word])
        XCTAssertEqual(kinds("1:2:3:4"), [.word])
    }

    func testCaseAndWhitespace() {
        XCTAssertEqual(texts("  RDLs   8 at 185 "), ["rdls", "8", "at", "185"])
        XCTAssertEqual(texts("bench\t225\n"), ["bench", "225"])
        XCTAssertEqual(texts(""), [])
        XCTAssertEqual(texts("   "), [])
    }

    func testNumberWordsStayWords() {
        XCTAssertEqual(kinds("two twenty five"), [.word, .word, .word])
        XCTAssertEqual(texts("two twenty five"), ["two", "twenty", "five"])
    }
}
