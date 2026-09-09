import XCTest
@testable import ApexCore

final class MarkdownBlockTests: XCTestCase {
    func testParagraphsSplitOnBlankLines() {
        XCTAssertEqual(MarkdownBlocks.parse("one\ntwo\n\nthree"), [.paragraph("one\ntwo"), .paragraph("three")])
    }

    func testHeadings() {
        XCTAssertEqual(MarkdownBlocks.parse("# Week\n## Day\n### Set\n#### nope\n#not"), [
            .heading(level: 1, text: "Week"), .heading(level: 2, text: "Day"), .heading(level: 3, text: "Set"),
            .paragraph("#### nope\n#not"),
        ])
    }

    func testUnorderedListDashStarAndBullet() {
        XCTAssertEqual(MarkdownBlocks.parse("- a\n* b\n• c\nnot an item"), [
            .list(ordered: false, items: ["a", "b", "c"]), .paragraph("not an item"),
        ])
    }

    func testOrderedList() {
        XCTAssertEqual(MarkdownBlocks.parse("1. warm up\n2) squat\n10. done"), [
            .list(ordered: true, items: ["warm up", "squat", "done"]),
        ])
    }

    func testMixedListKindsSplit() {
        XCTAssertEqual(MarkdownBlocks.parse("- a\n1. b"), [
            .list(ordered: false, items: ["a"]), .list(ordered: true, items: ["b"]),
        ])
    }

    func testFencedCodeWithLanguage() {
        XCTAssertEqual(MarkdownBlocks.parse("before\n```json\n{\"a\": 1}\n```\nafter"), [
            .paragraph("before"), .code("{\"a\": 1}", language: "json"), .paragraph("after"),
        ])
    }

    func testUnterminatedFenceWhileStreaming() {
        XCTAssertEqual(MarkdownBlocks.parse("```\nlet x ="), [.code("let x =", language: nil)])
    }

    func testMixedDocumentAndPlainTextPassthrough() {
        let text = "**Today**\n\n## Plan\n- Squat 5x5\n- Row\n\nThen rest."
        XCTAssertEqual(MarkdownBlocks.parse(text), [
            .paragraph("**Today**"), .heading(level: 2, text: "Plan"),
            .list(ordered: false, items: ["Squat 5x5", "Row"]), .paragraph("Then rest."),
        ])
        XCTAssertEqual(MarkdownBlocks.parse("just words"), [.paragraph("just words")])
        XCTAssertEqual(MarkdownBlocks.parse(""), [])
    }
}
