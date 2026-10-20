import ApexCore
import ApexPersistence
import XCTest

/// W17 M2: the voice journal — a ring of at most 200 transcripts and
/// outcomes, never audio, exported as JSON that reads back.
final class VoiceJournalTests: XCTestCase {
    private func entry(_ n: Int, action: VoiceJournalEntry.Action = .applied) -> VoiceJournalEntry {
        VoiceJournalEntry(
            timestamp: Date(timeIntervalSince1970: 1_790_078_400 + Double(n)), build: "561", endReason: .silence,
            alternatives: ["bench \(n) for 5", "bench \(n) four five"], chosen: 0,
            parse: VoiceJournalEntry.ParseSummary(status: "ok", intent: "log ×1 W\(n) R5", exercise: "session:bench exact", problems: [], ignored: [], score: 150, rules: ["R9"]),
            action: action, tapToListening: 0.21, lastPartialToFinal: 0.4, finalToApplied: 0.02, thermalState: "nominal",
            audioRoute: "Built-in Microphone → Speaker"
        )
    }

    func testTheRingKeepsTheLastTwoHundred() {
        var journal = VoiceJournal()
        for n in 0..<250 { journal.append(entry(n)) }
        XCTAssertEqual(journal.entries.count, VoiceJournal.capacity)
        XCTAssertEqual(journal.entries.first?.alternatives.first, "bench 50 for 5", "oldest dropped")
        XCTAssertEqual(journal.entries.last?.alternatives.first, "bench 249 for 5")
        XCTAssertEqual(VoiceJournal(entries: (0..<300).map { entry($0) }).entries.count, 200, "a decoded journal is capped too")
    }

    func testMarkLastUndoneAndClear() {
        var journal = VoiceJournal()
        journal.markLastUndone()
        journal.append(entry(1))
        journal.append(entry(2))
        journal.markLastUndone()
        XCTAssertEqual(journal.entries.map(\.undoneWithinWindow), [false, true])
        journal.clear()
        XCTAssertTrue(journal.entries.isEmpty)
    }

    func testTheExportHasEveryFieldNoAudioAndReadsBack() throws {
        var journal = VoiceJournal()
        journal.append(entry(1))
        journal.append(entry(2, action: .confirming))
        let data = try journal.exportJSON()
        let text = String(decoding: data, as: UTF8.self)
        for key in ["timestamp", "build", "endReason", "alternatives", "chosen", "parse", "action", "undoneWithinWindow",
                    "tapToListening", "lastPartialToFinal", "finalToApplied", "thermalState", "audioRoute", "status", "intent", "exercise", "rules"] {
            XCTAssertTrue(text.contains("\"\(key)\""), "missing \(key)")
        }
        XCTAssertFalse(text.lowercased().contains("audio\""), "no audio field")
        XCTAssertFalse(text.contains("\"data\""), "no sample bytes")
        XCTAssertTrue(text.contains("2026-09-22T12:00:01Z"), "ISO dates")
        XCTAssertEqual(try VoiceJournal.decode(data), journal)
        XCTAssertLessThan(data.count, 2_000, "two entries, under 2 KB: 200 fit in a share sheet")
    }

    func testTheParseSummaryFlattensAParse() {
        let intent = SpokenIntent.log(sets: 3, values: SpokenValues(weight: SpokenWeight(value: 62.5, unit: .kg), reps: 8, rpe: 8.5, isWarmup: true))
        XCTAssertEqual(VoiceJournalEntry.ParseSummary.describe(intent), "log ×3 W62.5 kg R8 rpe8.5 warm")
        XCTAssertEqual(VoiceJournalEntry.ParseSummary.describe(.repeat), "repeat")
        XCTAssertEqual(VoiceJournalEntry.ParseSummary.describe(.resolved(scope: .session, id: "fx-press", name: "Fixture Press", match: .contained)), "session:fx-press contained")
        XCTAssertEqual(VoiceJournalEntry.ParseSummary.describe(.needsConfirmation(phrase: "curls", candidates: [])), "confirm[0]")
        XCTAssertEqual(VoiceJournalEntry.ParseSummary.describe(.unresolved(phrase: "x")), "unresolved")
        XCTAssertEqual(VoiceJournalEntry.ParseSummary.describe(.current), "current")
    }

    func testTheFileStorePersistsAcrossInstancesAndClears() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-journal-\(UUID().uuidString)/journal.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let first = FileVoiceJournalStore(url: url)
        XCTAssertTrue(first.load().entries.isEmpty)
        first.append(entry(1))
        first.append(entry(2))
        first.markLastUndone()

        let second = FileVoiceJournalStore(url: url)
        XCTAssertEqual(second.load().entries.count, 2)
        XCTAssertEqual(second.load().entries.last?.undoneWithinWindow, true)
        second.clear()
        XCTAssertTrue(second.load().entries.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(FileVoiceJournalStore(url: url).load().entries.isEmpty)

        let memory = MemoryVoiceJournalStore(entries: [entry(1)])
        memory.append(entry(2))
        memory.markLastUndone()
        XCTAssertEqual(memory.load().entries.map(\.undoneWithinWindow), [false, true])
        memory.clear()
        XCTAssertTrue(memory.load().entries.isEmpty)
    }
}
