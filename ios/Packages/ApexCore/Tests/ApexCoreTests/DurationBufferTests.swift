import XCTest
@testable import ApexCore

/// The vectors of src/lib/__tests__/durationBuffer.test.ts and time.ts, plus
/// the field state machine DurationInput.tsx keeps inline (D-024).
final class DurationBufferTests: XCTestCase {
    func testDigitsToDisplayShowsLiteralRightToLeftGroups() {
        XCTAssertEqual(DurationBuffer.digitsToDisplay(""), "")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("2"), "0:02")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("23"), "0:23")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("230"), "2:30")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("2345"), "23:45")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("12345"), "1:23:45")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("123456"), "12:34:56")
    }

    func testDigitsToDisplayKeepsOverflowLiteralWhileTyping() {
        XCTAssertEqual(DurationBuffer.digitsToDisplay("90"), "0:90")
        XCTAssertEqual(DurationBuffer.digitsToDisplay("999"), "9:99")
    }

    func testDigitsToSecondsSplitsGroupsFromTheRight() {
        XCTAssertEqual(DurationBuffer.digitsToSeconds("2"), 2)
        XCTAssertEqual(DurationBuffer.digitsToSeconds("75"), 75)
        XCTAssertEqual(DurationBuffer.digitsToSeconds("90"), 90)
        XCTAssertEqual(DurationBuffer.digitsToSeconds("230"), 150)
        XCTAssertEqual(DurationBuffer.digitsToSeconds("2345"), 1425)
        XCTAssertEqual(DurationBuffer.digitsToSeconds("10500"), 3900)
        XCTAssertEqual(DurationBuffer.digitsToSeconds("123456"), 45296)
    }

    func testOverflowRollsUpThroughFormatSecondsOnCommit() {
        let commit = { (d: String) in DurationBuffer.formatSeconds(Double(DurationBuffer.digitsToSeconds(d))) }
        XCTAssertEqual(commit("90"), "1:30")
        XCTAssertEqual(commit("230"), "2:30")
        XCTAssertEqual(commit("2"), "2s")
        XCTAssertEqual(commit("10500"), "1:05:00")
    }

    func testIsPlainAcceptsSingleDurationTokens() {
        for v in ["", "2", "90s", "1:30", "2 min", "1:05:00", "1.5m"] {
            XCTAssertTrue(DurationBuffer.isPlain(v), v)
        }
    }

    func testIsPlainRejectsIntervalStyleFreeText() {
        for v in ["10s on 5s off", "each side", "to failure", "2x30s"] {
            XCTAssertFalse(DurationBuffer.isPlain(v), v)
        }
    }

    func testFormatElapsedAndClock() {
        XCTAssertEqual(DurationBuffer.formatElapsed(330), "05:30")
        XCTAssertEqual(DurationBuffer.formatElapsed(3930), "1:05:30")
        XCTAssertEqual(DurationBuffer.formatElapsed(0), "00:00")
        XCTAssertEqual(DurationBuffer.formatClock(2492), "41:32")
        XCTAssertEqual(DurationBuffer.formatClock(3723), "1:02:03")
        XCTAssertEqual(DurationBuffer.formatClock(65), "1:05")
    }

    func testParseDurationSeconds() {
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("90s"), 90)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("2 min"), 120)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("1.5min"), 90)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("1 hr"), 3600)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("60"), 60)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("1:30"), 90)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("1:05:00"), 3900)
        XCTAssertEqual(DurationBuffer.parseDurationSeconds("41:32"), 2492)
        XCTAssertNil(DurationBuffer.parseDurationSeconds("fast"))
        XCTAssertNil(DurationBuffer.parseDurationSeconds("0"))
        XCTAssertNil(DurationBuffer.parseDurationSeconds("3 laps"))
        XCTAssertNil(DurationBuffer.parseDurationSeconds(nil))
    }

    // MARK: - DurationEntry (the e2e vectors of tracker.spec.ts)

    func testFillsAWholeDurationFromOneTapStopwatchStyle() {
        var entry = DurationEntry(value: "")
        var stored = ""
        entry.beginEditing()
        XCTAssertEqual(entry.display(stored: stored), "")
        stored = entry.change(raw: "2")!
        XCTAssertEqual(entry.display(stored: stored), "0:02")
        stored = entry.change(raw: "0:023")!
        XCTAssertEqual(entry.display(stored: stored), "0:23")
        stored = entry.change(raw: "0:230")!
        XCTAssertEqual(entry.display(stored: stored), "2:30")
        XCTAssertEqual(stored, "2:30")
        entry.endEditing()
        XCTAssertEqual(entry.display(stored: stored), "2:30")

        // Re-entry is retype, not edit: the stored value moves into the placeholder.
        entry.beginEditing()
        XCTAssertEqual(entry.display(stored: stored), "")
        XCTAssertEqual(entry.placeholder(stored: stored, ghost: nil), "2:30")
        entry.endEditing()
        XCTAssertEqual(entry.display(stored: stored), "2:30")
    }

    func testCommitFormatsAndOverflowRollsUp() {
        var entry = DurationEntry(value: "")
        entry.beginEditing()
        XCTAssertEqual(entry.change(raw: "2"), "2s")
        entry.endEditing()
        entry.beginEditing()
        XCTAssertEqual(entry.change(raw: "9"), "9s")
        XCTAssertEqual(entry.change(raw: "0:090"), "1:30")
        XCTAssertEqual(entry.display(stored: "1:30"), "0:90")
        entry.endEditing()
        XCTAssertEqual(entry.display(stored: "1:30"), "1:30")
    }

    func testASeventhDigitIsIgnored() {
        var entry = DurationEntry(value: "")
        entry.beginEditing()
        _ = entry.change(raw: "123456")
        XCTAssertNil(entry.change(raw: "12:34:567"))
        XCTAssertEqual(entry.buffer, "123456")
    }

    func testNonDigitSwitchesToTextSeededWithWhatWasTyped() {
        var entry = DurationEntry(value: "")
        entry.beginEditing()
        _ = entry.change(raw: "1")
        _ = entry.change(raw: "0:010")
        XCTAssertEqual(entry.display(stored: "10s"), "0:10")
        // Typing "s" after the displayed "0:10" means "10s", not "0:10s".
        XCTAssertEqual(entry.change(raw: "0:10s"), "10s")
        XCTAssertEqual(entry.mode, .text)
        XCTAssertNil(entry.buffer)
        XCTAssertEqual(entry.display(stored: "10s"), "10s")
        XCTAssertEqual(entry.placeholder(stored: "10s", ghost: nil), "")
        XCTAssertEqual(entry.change(raw: "10s on 5s off"), "10s on 5s off")
        XCTAssertEqual(entry.mode, .text)
    }

    func testATrailingDotIsTheEscapeHatchAndIsDropped() {
        var entry = DurationEntry(value: "")
        entry.beginEditing()
        _ = entry.change(raw: "9")
        _ = entry.change(raw: "0:090")
        XCTAssertEqual(entry.change(raw: "0:90."), "90")
        XCTAssertEqual(entry.mode, .text)
    }

    func testClearingTextReturnsToStopwatch() {
        var entry = DurationEntry(value: "10s on 5s off")
        XCTAssertEqual(entry.mode, .text)
        entry.beginEditing()
        XCTAssertNil(entry.buffer)
        XCTAssertEqual(entry.change(raw: ""), "")
        XCTAssertEqual(entry.mode, .stopwatch)
        XCTAssertEqual(entry.buffer, "")
        XCTAssertEqual(entry.placeholder(stored: "", ghost: nil), "0:00")
        XCTAssertEqual(entry.change(raw: "4"), "4s")
        XCTAssertEqual(entry.change(raw: "0:045"), "45s")
    }

    func testBackspaceOnAnEmptyBufferClearsTheStoredValue() {
        var entry = DurationEntry(value: "2:30")
        XCTAssertNil(entry.deleteBackwardOnEmptyBuffer(stored: "2:30"))
        entry.beginEditing()
        XCTAssertEqual(entry.deleteBackwardOnEmptyBuffer(stored: "2:30"), "")
        XCTAssertNil(entry.deleteBackwardOnEmptyBuffer(stored: ""))
        _ = entry.change(raw: "3")
        XCTAssertNil(entry.deleteBackwardOnEmptyBuffer(stored: "3s"))
    }

    func testSyncRederivesTheModeOnlyForExternalChanges() {
        var entry = DurationEntry(value: "")
        entry.beginEditing()
        _ = entry.change(raw: "1")
        _ = entry.change(raw: "0:01x")
        XCTAssertEqual(entry.mode, .text)
        // Our own emit ("1x") is not an external change; a plain-looking intermediate stays text.
        entry.sync(stored: "1x")
        XCTAssertEqual(entry.mode, .text)
        _ = entry.change(raw: "10")
        entry.sync(stored: "10")
        XCTAssertEqual(entry.mode, .text)
        entry.endEditing()
        // A shadow commit writes "2:00" from outside: stopwatch again.
        entry.sync(stored: "2:00")
        XCTAssertEqual(entry.mode, .stopwatch)
        entry.sync(stored: "each side")
        XCTAssertEqual(entry.mode, .text)
    }

    func testPlaceholderPrefersTheGhostWhenNothingIsStored() {
        let entry = DurationEntry(value: "")
        XCTAssertEqual(entry.placeholder(stored: "", ghost: "1:45"), "1:45")
        XCTAssertEqual(entry.placeholder(stored: "", ghost: ""), "0:00")
    }
}
