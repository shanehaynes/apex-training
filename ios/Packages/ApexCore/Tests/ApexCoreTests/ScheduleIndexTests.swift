import XCTest
@testable import ApexCore

final class ScheduleIndexTests: XCTestCase {
    private func response(_ json: String) throws -> ScheduleResponse {
        try JSONDecoder().decode(ScheduleResponse.self, from: Data(json.utf8))
    }

    private let sample = """
    {"window":{"start":"2026-09-01","end":"2026-09-30"},
     "bases":[
       {"id":"a","type":"weights","title":"Zed lift","date":"2026-09-08","startTime":"17:30","estimatedDuration":60},
       {"id":"b","type":"cardio","title":"Run","date":"2026-09-08","startTime":"06:00"},
       {"id":"c","type":"yoga","title":"Untimed","date":"2026-09-08"},
       {"id":"d","type":"yoga","title":"Alpha untimed","date":"2026-09-08"}
     ],
     "occurrences":[
       {"id":"a__2026-09-08","baseId":"a","date":"2026-09-08","startTime":"17:30","endTime":null,"isCompleted":false,"completedAt":null},
       {"id":"b","baseId":"b","date":"2026-09-08","startTime":"06:00","endTime":null,"isCompleted":true,"completedAt":"<timestamp>"},
       {"id":"c","baseId":"c","date":"2026-09-08","startTime":null,"endTime":null,"isCompleted":false,"completedAt":null},
       {"id":"d","baseId":"d","date":"2026-09-08","startTime":null,"endTime":null,"isCompleted":false,"completedAt":null},
       {"id":"orphan","baseId":"missing","date":"2026-09-09","startTime":null,"endTime":null,"isCompleted":false,"completedAt":null},
       {"id":"a__2026-09-15","baseId":"a","date":"2026-09-15","startTime":"07:00","endTime":null,"isCompleted":false,"completedAt":null}
     ]}
    """

    func testSortsByStartTimeThenTitleAndDropsOrphans() throws {
        let index = ScheduleIndex(try response(sample))
        let day = DayKey("2026-09-08")!
        XCTAssertEqual(index.events(on: day).map(\.id), ["b", "a__2026-09-08", "d", "c"])
        XCTAssertEqual(index.events(on: DayKey("2026-09-09")!), [])
        XCTAssertEqual(index.count, 5)
        XCTAssertEqual(index.horizon?.string, "2026-09-30")
    }

    func testMovedOccurrenceKeepsItsOwnTime() throws {
        let index = ScheduleIndex(try response(sample))
        XCTAssertEqual(index.event(id: "a__2026-09-15")?.startTime, "07:00")
        XCTAssertEqual(index.event(id: "a__2026-09-15")?.title, "Zed lift")
        XCTAssertTrue(index.event(id: "b")?.isCompleted ?? false)
    }

    func testTypeDotsAreDistinctAndCapped() throws {
        let index = ScheduleIndex(try response(sample))
        XCTAssertEqual(index.typeDots(on: DayKey("2026-09-08")!), [.cardio, .weights, .yoga])
        XCTAssertEqual(index.typeDots(on: DayKey("2026-09-08")!, max: 2), [.cardio, .weights])
    }

    func testSettingCompletionFlipsOneStub() throws {
        let index = ScheduleIndex(try response(sample))
        let flipped = index.settingCompletion(id: "a__2026-09-08", isCompleted: true, completedAt: "2026-09-08T18:00:00.000Z")
        XCTAssertTrue(flipped.event(id: "a__2026-09-08")!.isCompleted)
        XCTAssertEqual(flipped.event(id: "a__2026-09-08")!.completedAt, "2026-09-08T18:00:00.000Z")
        XCTAssertFalse(flipped.event(id: "a__2026-09-15")!.isCompleted)
        XCTAssertFalse(index.event(id: "a__2026-09-08")!.isCompleted, "the original is untouched")

        let back = flipped.settingCompletion(id: "b", isCompleted: false, completedAt: "ignored")
        XCTAssertFalse(back.event(id: "b")!.isCompleted)
        XCTAssertNil(back.event(id: "b")!.completedAt)
        // The response round-trips through the cache unchanged in shape.
        XCTAssertEqual(back.response.occurrences.count, 6)
    }

    func testMonthGridPadsToWholeRows() {
        // September 2026 starts on a Tuesday.
        let mondayFirst = MonthGrid.cells(year: 2026, month: 9, firstWeekday: 2)
        XCTAssertEqual(mondayFirst.count, 35)
        XCTAssertEqual(mondayFirst.prefix(2).map { $0?.day }, [nil, 1])
        let sundayFirst = MonthGrid.cells(year: 2026, month: 9, firstWeekday: 1)
        XCTAssertEqual(sundayFirst.prefix(3).map { $0?.day }, [nil, nil, 1])
        XCTAssertEqual(sundayFirst.count, 35)
        // February 2026 starts on a Sunday and has exactly four Sunday-first rows.
        XCTAssertEqual(MonthGrid.cells(year: 2026, month: 2, firstWeekday: 1).count, 28)
        XCTAssertEqual(MonthGrid.title(year: 2026, month: 9), "September 2026")
        XCTAssertEqual(MonthGrid.weekdayLetters(firstWeekday: 2), ["M", "T", "W", "T", "F", "S", "S"])
        XCTAssertEqual(MonthGrid.step(year: 2026, month: 12, by: 1).month, 1)
        XCTAssertEqual(MonthGrid.step(year: 2026, month: 12, by: 1).year, 2027)
        XCTAssertEqual(MonthGrid.step(year: 2026, month: 1, by: -1).year, 2025)
    }

    func testWeekPage() {
        let week = WeekPage.days(containing: DayKey("2026-09-04")!, firstWeekday: 1)
        XCTAssertEqual(week.first?.string, "2026-08-30")
        XCTAssertEqual(week.last?.string, "2026-09-05")
        XCTAssertEqual(WeekPage.days(containing: DayKey("2026-09-04")!, firstWeekday: 2).first?.string, "2026-08-31")
    }

    func testWindowAroundToday() {
        let window = ScheduleWindow.around(DayKey("2026-09-04")!)
        XCTAssertEqual(window.start.string, "2026-07-06")
        XCTAssertEqual(window.end.string, "2027-01-02")
        XCTAssertTrue(window.contains(DayKey("2026-09-04")!))
        XCTAssertFalse(window.contains(DayKey("2027-01-03")!))
        XCTAssertEqual(ScheduleCacheKey.meals(year: 2026, month: 9), "2026-09")
    }
}
