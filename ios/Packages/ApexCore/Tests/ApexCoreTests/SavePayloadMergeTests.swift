import XCTest
@testable import ApexCore

/// Two consecutive saves become one envelope that lands the same end state.
final class SavePayloadMergeTests: XCTestCase {
    private let k1 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 1)
    private let k2 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 2)
    private let k3 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 3)

    func testLaterValueWinsPerKeyAndUntouchedKeysAreKept() {
        let first = SavePayload(setLogs: [setRow(1, weight: "100"), setRow(2, weight: "100")])
        let second = SavePayload(setLogs: [setRow(2, weight: "110"), setRow(3, weight: "120")])
        let merged = first.merging(second)
        XCTAssertEqual(merged.setLogs.map(\.setNumber), [1, 2, 3])
        XCTAssertEqual(merged.setLogs.map(\.actualWeight), ["100", "110", "120"])
        XCTAssertTrue(merged.removedSets.isEmpty)
    }

    func testALaterRemovalDropsTheEarlierUpsertOfThatKey() {
        let first = SavePayload(setLogs: [setRow(1), setRow(3)])
        let second = SavePayload(removedSets: [k3])
        let merged = first.merging(second)
        XCTAssertEqual(merged.setLogs.map(\.key), [k1])
        XCTAssertEqual(merged.removedSets, [k3])
        XCTAssertTrue(merged.setKeys.contains(k3))
    }

    func testALaterUpsertRevivesARemovedKey() {
        let first = SavePayload(removedSets: [k3])
        let second = SavePayload(setLogs: [setRow(3, weight: "90")])
        let merged = first.merging(second)
        XCTAssertEqual(merged.setLogs.map(\.key), [k3])
        XCTAssertTrue(merged.removedSets.isEmpty)
    }

    /// The server runs upserts and deletes in one un-ordered batch.
    func testAKeyIsNeverInBothLists() {
        var payload = SavePayload()
        let steps: [SavePayload] = [
            SavePayload(setLogs: [setRow(1), setRow(2)]),
            SavePayload(removedSets: [k2]),
            SavePayload(setLogs: [setRow(2)]),
            SavePayload(removedSets: [k1, k2]),
            SavePayload(setLogs: [setRow(3)], removedSets: [k1]),
        ]
        for step in steps {
            payload = payload.merging(step)
            let upserted = Set(payload.setLogs.map(\.key))
            XCTAssertTrue(upserted.isDisjoint(with: payload.removedSets), "\(payload)")
        }
        XCTAssertEqual(payload.setLogs.map(\.key), [k3])
        XCTAssertEqual(Set(payload.removedSets), [k1, k2])
    }

    func testCardioUpsertsByExercise() {
        let row = { (minutes: Double) in
            CardioLogRow(eventId: "e", eventDate: "d", section: "exercise", exerciseId: "fx-row", exerciseName: "Row", durationMinutes: minutes)
        }
        let merged = SavePayload(cardioLogs: [row(20)]).merging(SavePayload(cardioLogs: [row(25)]))
        XCTAssertEqual(merged.cardioLogs.map(\.durationMinutes), [25])
    }

    func testServerCap() {
        let big = SavePayload(setLogs: (1...500).map { setRow($0) })
        XCTAssertFalse(big.exceedsServerCap)
        XCTAssertTrue(big.merging(SavePayload(setLogs: [setRow(501)])).exceedsServerCap)
        XCTAssertTrue(SavePayload().isEmpty)
        XCTAssertFalse(SavePayload(removedSets: [k1]).isEmpty)
    }
}
