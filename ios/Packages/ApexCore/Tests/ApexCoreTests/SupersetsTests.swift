import XCTest
@testable import ApexCore

/// `src/lib/schedule/__tests__/supersets.test.ts`, vector for vector.
final class SupersetsTests: XCTestCase {
    private func ex(_ id: String, _ superset: String? = nil) -> Exercise {
        Exercise(id: id, name: id, category: "strength", superset: superset)
    }
    private func labels(_ entries: [Exercise]) -> [String?] { entries.map(\.superset) }

    func testRelettersRunsInOrderOfAppearance() {
        XCTAssertEqual(labels(Supersets.normalize([ex("a", "X"), ex("b", "X"), ex("c"), ex("d", "Q"), ex("e", "Q")])),
                       ["A", "A", nil, "B", "B"])
    }

    func testClearsSingletonLabels() {
        XCTAssertEqual(labels(Supersets.normalize([ex("a", "A"), ex("b"), ex("c", "A")])), [nil, nil, nil])
    }

    func testSplitsALabelSeparatedByAReorderIntoDistinctGroups() {
        XCTAssertEqual(labels(Supersets.normalize([ex("a", "A"), ex("b", "A"), ex("c"), ex("d", "A"), ex("e", "A")])),
                       ["A", "A", nil, "B", "B"])
    }

    func testKeepsUntouchedEntriesEqual() {
        let plain = ex("a")
        let grouped = [ex("b", "A"), ex("c", "A")]
        let out = Supersets.normalize([plain] + grouped)
        XCTAssertEqual(out[0], plain)
        XCTAssertEqual(out[1], grouped[0])
        XCTAssertEqual(out, [plain] + grouped)
    }

    func testPairsAnEntryWithTheOneAboveIt() {
        XCTAssertEqual(labels(Supersets.linkWithAbove([ex("a"), ex("b")], id: "b")), ["A", "A"])
    }

    func testJoinsAnExistingGroupAbove() {
        XCTAssertEqual(labels(Supersets.linkWithAbove([ex("a", "A"), ex("b", "A"), ex("c")], id: "c")), ["A", "A", "A"])
    }

    func testLinkIsANoOpOnTheFirstEntry() {
        let entries = [ex("a"), ex("b")]
        XCTAssertEqual(Supersets.linkWithAbove(entries, id: "a"), entries)
    }

    func testUnlinkDissolvesAPairAndRelettersWhatRemains() {
        XCTAssertEqual(labels(Supersets.unlink([ex("a", "A"), ex("b", "A"), ex("c", "B"), ex("d", "B")], id: "a")),
                       [nil, nil, "A", "A"])
    }

    func testUnlinkFromATrioLeavesTheRemainingPairGrouped() {
        XCTAssertEqual(labels(Supersets.unlink([ex("a", "A"), ex("b", "A"), ex("c", "A")], id: "c")), ["A", "A", nil])
    }
}
