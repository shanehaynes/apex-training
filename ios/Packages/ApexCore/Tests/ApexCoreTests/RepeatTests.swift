import XCTest
@testable import ApexCore

/// `src/lib/builder/__tests__/repeat.test.ts`, vector for vector.
final class RepeatTests: XCTestCase {
    private func state(_ days: [Weekday], interval: String = "1", until: String = "", enabled: Bool = true) -> DraftRepeat {
        DraftRepeat(enabled: enabled, days: days, interval: interval, until: until)
    }

    // MARK: ruleFromRepeat

    func testSerializesDaysInCanonicalOrderWithIntervalAndUntil() {
        XCTAssertEqual(Repeat.rule(from: state([.friday, .monday], interval: "2", until: "2026-12-31")),
                       "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231")
    }

    func testOmitsIntervalOneAndUntilWhenUnset() {
        XCTAssertEqual(Repeat.rule(from: state([.monday])), "FREQ=WEEKLY;BYDAY=MO")
    }

    func testReturnsNilWhenOffOrDaylessAndTheCustomRuleVerbatim() {
        XCTAssertNil(Repeat.rule(from: .off))
        XCTAssertNil(Repeat.rule(from: state([])))
        var custom = DraftRepeat.off
        custom.enabled = true
        custom.custom = "FREQ=MONTHLY;BYMONTHDAY=1"
        XCTAssertEqual(Repeat.rule(from: custom), "FREQ=MONTHLY;BYMONTHDAY=1")
    }

    // MARK: repeatFromRule

    func testRoundTripsAWeeklyRuleIntoThePicker() {
        let parsed = Repeat.fromRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231")
        XCTAssertEqual(parsed, state([.monday, .friday], interval: "2", until: "2026-12-31"))
        XCTAssertEqual(Repeat.rule(from: parsed), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231")
    }

    func testKeepsInexpressibleRulesAsCustomVerbatim() {
        for rule in ["FREQ=DAILY", "FREQ=MONTHLY;BYMONTHDAY=15", "FREQ=WEEKLY;BYDAY=MO;COUNT=10", "FREQ=WEEKLY", "not a rule", "FREQ=WEEKLY;BYDAY=1MO"] {
            let parsed = Repeat.fromRule(rule)
            XCTAssertTrue(parsed.enabled, rule)
            XCTAssertEqual(parsed.custom, rule)
            XCTAssertEqual(Repeat.rule(from: parsed), rule)
        }
    }

    func testMapsNoRuleToOff() {
        XCTAssertEqual(Repeat.fromRule(nil), .off)
        XCTAssertEqual(Repeat.fromRule(""), .off)
    }

    // MARK: snapAnchorDate (2026-08-27 is a Thursday)

    func testKeepsADateAlreadyOnASelectedWeekday() {
        XCTAssertEqual(Repeat.snapAnchorDate("2026-08-27", days: [.thursday]), "2026-08-27")
    }

    func testAdvancesToTheFirstSelectedWeekday() {
        XCTAssertEqual(Repeat.snapAnchorDate("2026-08-27", days: [.monday, .wednesday]), "2026-08-31")
        XCTAssertEqual(Repeat.snapAnchorDate("2026-08-27", days: [.friday]), "2026-08-28")
        XCTAssertEqual(Repeat.snapAnchorDate("2026-08-27", days: [.sunday]), "2026-08-30")
    }

    func testIsANoOpWithNoDaysSelected() {
        XCTAssertEqual(Repeat.snapAnchorDate("2026-08-27", days: []), "2026-08-27")
    }

    // MARK: repeatProblem

    func testRequiresDaysAndASaneIntervalWhenEnabled() {
        XCTAssertTrue(Repeat.problem(state([]), anchorDate: "2026-08-27")?.contains("day") ?? false)
        XCTAssertTrue(Repeat.problem(state([.monday], interval: "0"), anchorDate: "2026-08-27")?.contains("interval") ?? false)
    }

    func testRejectsAnEndDateBeforeTheFirstSnappedOccurrence() {
        // Anchor snaps Thursday → Monday the 31st, past the until date.
        XCTAssertTrue(Repeat.problem(state([.monday], until: "2026-08-29"), anchorDate: "2026-08-27")?.contains("end date") ?? false)
        XCTAssertNil(Repeat.problem(state([.monday], until: "2026-08-31"), anchorDate: "2026-08-27"))
    }

    func testStaysQuietWhenOffOrCustom() {
        XCTAssertNil(Repeat.problem(.off, anchorDate: "2026-08-27"))
        XCTAssertNil(Repeat.problem(Repeat.fromRule("FREQ=DAILY"), anchorDate: "2026-08-27"))
    }

    func testChipOrderAndLabelsAreMondayFirst() {
        XCTAssertEqual(Weekday.chipOrder.map(\.rawValue), ["MO", "TU", "WE", "TH", "FR", "SA", "SU"])
        XCTAssertEqual(Weekday.chipOrder.map(\.label), ["M", "T", "W", "T", "F", "S", "S"])
        XCTAssertEqual(Weekday(calendarWeekday: 1), .sunday)
        XCTAssertEqual(Weekday(calendarWeekday: 7), .saturday)
    }

    func testDraftRepeatCodesLikeTheWeb() throws {
        let json = #"{"enabled":true,"days":["MO","FR"],"interval":"2","until":"2026-12-31"}"#
        let decoded = try JSONDecoder().decode(DraftRepeat.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, state([.monday, .friday], interval: "2", until: "2026-12-31"))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(String(decoding: try encoder.encode(decoded), as: UTF8.self),
                       #"{"days":["MO","FR"],"enabled":true,"interval":"2","until":"2026-12-31"}"#)
    }
}
