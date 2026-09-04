import XCTest
@testable import ApexCore

final class DayKeyTests: XCTestCase {
    func testParsesStrictDatesOnly() {
        XCTAssertEqual(DayKey("2026-09-04"), DayKey(year: 2026, month: 9, day: 4))
        XCTAssertNil(DayKey("2026-9-4"))
        XCTAssertNil(DayKey("2026-02-30"))
        XCTAssertNil(DayKey("2026-09-04T00:00:00Z"))
        XCTAssertEqual(DayKey("2028-02-29")?.day, 29)
    }

    func testArithmeticCrossesMonthsAndYears() {
        let day = DayKey("2026-12-30")!
        XCTAssertEqual(day.adding(days: 3).string, "2027-01-02")
        XCTAssertEqual(day.adding(days: -60).string, "2026-10-31")
        XCTAssertEqual(DayKey("2026-09-04")!.days(until: DayKey("2026-09-08")!), 4)
        XCTAssertLessThan(DayKey("2026-09-04")!, DayKey("2026-10-01")!)
    }

    func testWeekdayIsCalendarConvention() {
        XCTAssertEqual(DayKey("2026-09-06")!.weekday, 1) // Sunday
        XCTAssertEqual(DayKey("2026-09-01")!.weekday, 3) // Tuesday
    }

    func testTodayFollowsTheZone() {
        // 03:30 UTC on the 5th is still the 4th in New York.
        let clock = TestClock(now: Date(timeIntervalSince1970: 1_788_579_000)) // 2026-09-05T03:30:00Z
        XCTAssertEqual(DayKey.today(clock: clock, timeZone: TimeZone(identifier: "UTC")!).string, "2026-09-05")
        XCTAssertEqual(DayKey.today(clock: clock, timeZone: TimeZone(identifier: "America/New_York")!).string, "2026-09-04")
    }

    func testCodableAsString() throws {
        let data = try JSONEncoder().encode([DayKey("2026-09-04")!])
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "[\"2026-09-04\"]")
        XCTAssertEqual(try JSONDecoder().decode([DayKey].self, from: data).first?.month, 9)
    }

    func testTimeLabels() {
        XCTAssertEqual(TimeLabel.display("17:30"), "5:30 PM")
        XCTAssertEqual(TimeLabel.display("07:05"), "7:05 AM")
        XCTAssertEqual(TimeLabel.display("00:00"), "12:00 AM")
        XCTAssertEqual(TimeLabel.display("12:30"), "12:30 PM")
        XCTAssertEqual(TimeLabel.display("5:30 PM"), "5:30 PM")
        XCTAssertEqual(TimeLabel.display("noonish"), "noonish")
        XCTAssertNil(TimeLabel.display(nil))
        XCTAssertEqual(TimeLabel.minutes("12:00 AM"), 0)
        XCTAssertEqual(TimeLabel.minutes("12:15 PM"), 735)
        XCTAssertNil(TimeLabel.minutes("25:00"))
        XCTAssertEqual(TimeLabel.range(start: "17:30", end: "18:30"), "5:30 PM – 6:30 PM")
        XCTAssertEqual(TimeLabel.range(start: "17:30", end: nil), "5:30 PM")
        XCTAssertEqual(TimeLabel.duration(minutes: 45), "45m")
        XCTAssertEqual(TimeLabel.duration(minutes: 120), "2h")
        XCTAssertEqual(TimeLabel.duration(minutes: 90), "1h 30m")
        XCTAssertEqual(TimeLabel.elapsed(seconds: 330), "05:30")
        XCTAssertEqual(TimeLabel.elapsed(seconds: 3930), "1:05:30")
    }
}
