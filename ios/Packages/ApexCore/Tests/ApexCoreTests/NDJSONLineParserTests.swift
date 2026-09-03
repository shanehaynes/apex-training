import XCTest
@testable import ApexCore

final class NDJSONLineParserTests: XCTestCase {
    func testSplitsCompleteLines() {
        var parser = NDJSONLineParser()
        XCTAssertEqual(parser.consume(Data("a\nb\n".utf8)), ["a", "b"])
        XCTAssertEqual(parser.finish(), [])
    }

    func testHoldsPartialLineUntilNewlineArrives() {
        var parser = NDJSONLineParser()
        XCTAssertEqual(parser.consume(Data("{\"type\":".utf8)), [])
        XCTAssertEqual(parser.consume(Data("\"done\"}\n".utf8)), ["{\"type\":\"done\"}"])
    }

    /// The failure this class exists to prevent: decoding each chunk as text on
    /// arrival would turn a character split across a chunk boundary into U+FFFD.
    func testSurvivesSplitMidMultibyteCharacter() {
        let bytes = Array("é·\n".utf8)
        var parser = NDJSONLineParser()
        for index in bytes.indices {
            let out = parser.consume(Data([bytes[index]]))
            if index == bytes.count - 1 {
                XCTAssertEqual(out, ["é·"])
            } else {
                XCTAssertTrue(out.isEmpty)
            }
        }
    }

    func testStripsCarriageReturnsAndSkipsBlankLines() {
        var parser = NDJSONLineParser()
        XCTAssertEqual(parser.consume(Data("a\r\n\n  \nb\r\n".utf8)), ["a", "b"])
    }

    /// A truncated stream still yields what it managed to send.
    func testFinishEmitsTrailingPartialLine() {
        var parser = NDJSONLineParser()
        XCTAssertEqual(parser.consume(Data("a\nb".utf8)), ["a"])
        XCTAssertEqual(parser.finish(), ["b"])
        XCTAssertEqual(parser.finish(), [], "finish must not repeat itself")
    }

    func testHandlesManyLinesInOneChunk() {
        var parser = NDJSONLineParser()
        let lines = (0..<500).map { "line \($0)" }
        let out = parser.consume(Data(lines.joined(separator: "\n").appending("\n").utf8))
        XCTAssertEqual(out, lines)
    }
}
