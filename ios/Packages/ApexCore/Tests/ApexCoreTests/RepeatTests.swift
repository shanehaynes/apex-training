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
        // Monthly, weekly without days, daily with days, both ends at once,
        // and the unparseable: none of these has a picker state.
        for rule in ["FREQ=MONTHLY;BYMONTHDAY=15", "FREQ=WEEKLY", "FREQ=WEEKLY;COUNT=3", "FREQ=DAILY;BYDAY=MO", "FREQ=WEEKLY;BYDAY=MO;COUNT=2;UNTIL=20261231", "not a rule", "FREQ=WEEKLY;BYDAY=1MO"] {
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
        XCTAssertNil(Repeat.problem(Repeat.fromRule("FREQ=MONTHLY"), anchorDate: "2026-08-27"))
    }

    func testChipOrderAndLabelsAreMondayFirst() {
        XCTAssertEqual(Weekday.chipOrder.map(\.rawValue), ["MO", "TU", "WE", "TH", "FR", "SA", "SU"])
        XCTAssertEqual(Weekday.chipOrder.map(\.label), ["M", "T", "W", "T", "F", "S", "S"])
        XCTAssertEqual(Weekday(calendarWeekday: 1), .sunday)
        XCTAssertEqual(Weekday(calendarWeekday: 7), .saturday)
    }

    // MARK: daily rules and count-based ends

    private func daily(interval: String = "1", until: String = "", count: String? = nil, days: [Weekday] = []) -> DraftRepeat {
        DraftRepeat(enabled: true, days: days, interval: interval, until: until, freq: .daily, count: count)
    }

    func testSerializesADailyRuleFromTheIntervalAloneDaysIgnored() {
        XCTAssertEqual(Repeat.rule(from: daily(interval: "2")), "FREQ=DAILY;INTERVAL=2")
        XCTAssertEqual(Repeat.rule(from: daily(until: "2026-12-31", days: [.monday])), "FREQ=DAILY;UNTIL=20261231")
    }

    func testSerializesCountForWeeklyAndDailyRules() {
        XCTAssertEqual(Repeat.rule(from: DraftRepeat(enabled: true, days: [.monday, .wednesday], interval: "1", until: "", count: "4")),
                       "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")
        XCTAssertEqual(Repeat.rule(from: daily(interval: "2", count: "6")), "FREQ=DAILY;INTERVAL=2;COUNT=6")
    }

    func testRoundTripsDailyAndCountedRulesThroughThePickerState() {
        XCTAssertEqual(Repeat.fromRule("FREQ=DAILY;INTERVAL=2"), daily(interval: "2"))
        XCTAssertEqual(Repeat.fromRule("FREQ=DAILY;COUNT=6"), daily(count: "6"))
        XCTAssertEqual(Repeat.fromRule("FREQ=WEEKLY;BYDAY=MO;COUNT=10"),
                       DraftRepeat(enabled: true, days: [.monday], interval: "1", until: "", count: "10"))
        for rule in ["FREQ=DAILY;INTERVAL=2", "FREQ=DAILY;COUNT=6", "FREQ=DAILY;INTERVAL=3;UNTIL=20261231", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=12"] {
            let parsed = Repeat.fromRule(rule)
            XCTAssertNil(parsed.custom, rule)
            XCTAssertEqual(Repeat.rule(from: parsed), rule)
        }
    }

    func testKeepsAWeeklyCountlessRuleInTheShapeOlderClientsSend() {
        let parsed = Repeat.fromRule("FREQ=WEEKLY;BYDAY=MO")
        XCTAssertNil(parsed.freq)
        XCTAssertNil(parsed.count)
        XCTAssertEqual(parsed, state([.monday]))
    }

    func testNeverEmitsCountAndUntilTogetherTheDateWinsTheProblemSaysSo() {
        let both = DraftRepeat(enabled: true, days: [.monday], interval: "1", until: "2026-12-31", count: "5")
        XCTAssertEqual(Repeat.rule(from: both), "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231")
        XCTAssertTrue(Repeat.problem(both, anchorDate: "2026-08-27")?.contains("not both") ?? false)
    }

    func testDropsABadCountFromTheRuleAndRefusesItAsAProblem() {
        for count in ["0", "-1", "x", "1.5"] {
            XCTAssertEqual(Repeat.rule(from: daily(count: count)), "FREQ=DAILY", count)
            XCTAssertTrue(Repeat.problem(daily(count: count), anchorDate: "2026-08-27")?.contains("count") ?? false, count)
        }
        XCTAssertNil(Repeat.problem(daily(count: ""), anchorDate: "2026-08-27"))
    }

    func testBoundsTheIntervalTheSameWayForDailyRules() {
        XCTAssertEqual(Repeat.rule(from: daily(interval: "0")), "FREQ=DAILY")
        XCTAssertEqual(Repeat.rule(from: daily(interval: "")), "FREQ=DAILY")
        XCTAssertTrue(Repeat.problem(daily(interval: "0"), anchorDate: "2026-08-27")?.contains("interval") ?? false)
        XCTAssertTrue(Repeat.problem(daily(interval: ""), anchorDate: "2026-08-27")?.contains("interval") ?? false)
    }

    func testNeedsNoDaysForADailyRuleAndChecksItsEndDateAgainstTheAnchorItself() {
        XCTAssertNil(Repeat.problem(daily(), anchorDate: "2026-08-27"))
        XCTAssertTrue(Repeat.problem(daily(until: "2026-08-26"), anchorDate: "2026-08-27")?.contains("end date") ?? false)
        XCTAssertNil(Repeat.problem(daily(until: "2026-08-27"), anchorDate: "2026-08-27"))
    }

    func testDailyAndCountedDraftsCodeLikeTheWeb() throws {
        let json = #"{"count":"6","days":[],"enabled":true,"freq":"DAILY","interval":"2","until":""}"#
        let decoded = try JSONDecoder().decode(DraftRepeat.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, daily(interval: "2", count: "6"))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(String(decoding: try encoder.encode(decoded), as: UTF8.self), json)
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
