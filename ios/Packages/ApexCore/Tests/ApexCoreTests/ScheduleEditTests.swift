import XCTest
@testable import ApexCore

/// The sheet's direct edits: exact bodies and the optimistic index.
final class ScheduleEditTests: XCTestCase {
    private let sample = """
    {"window":{"start":"2026-09-01","end":"2026-09-30"},
     "bases":[
       {"id":"a","type":"weights","title":"Zed","date":"2026-09-01","startTime":"17:30","endTime":"18:30","difficulty":3,
        "warmup":[{"id":"w","name":"Row","category":"cardio"}],"exercises":[{"id":"s","name":"Squat","category":"strength"}],
        "isRecurring":true,"recurrenceRule":"FREQ=WEEKLY;BYDAY=TU"},
       {"id":"b","type":"cardio","title":"Run","date":"2026-09-10","startTime":"6:30 AM","endTime":"7:15 AM","isRecurring":false}
     ],
     "occurrences":[
       {"id":"a","baseId":"a","date":"2026-09-01","originalDate":"2026-08-25","startTime":"17:30","endTime":"18:30","isCompleted":false,"completedAt":null},
       {"id":"a__2026-09-08","baseId":"a","date":"2026-09-08","originalDate":"2026-09-08","startTime":"17:30","endTime":"18:30","isCompleted":true,"completedAt":"<timestamp>"},
       {"id":"a__2026-09-15","baseId":"a","date":"2026-09-15","startTime":"07:00","endTime":null,"isCompleted":false,"completedAt":null},
       {"id":"b","baseId":"b","date":"2026-09-10","originalDate":"2026-09-10","startTime":"6:30 AM","endTime":"7:15 AM","isCompleted":false,"completedAt":null}
     ]}
    """

    private func index() throws -> ScheduleIndex {
        ScheduleIndex(try JSONDecoder().decode(ScheduleResponse.self, from: Data(sample.utf8)))
    }
    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }
    private let base = URL(string: "http://127.0.0.1:5314")!

    func testKeyDatePrecedence() throws {
        let index = try index()
        // A moved anchor keys on its row date, not the date it shows.
        XCTAssertEqual(index.event(id: "a")?.keyDate, "2026-08-25")
        // A generated occurrence's id carries its date when the stub lacks the field.
        XCTAssertEqual(index.event(id: "a__2026-09-15")?.keyDate, "2026-09-15")
        XCTAssertEqual(index.event(id: "b")?.keyDate, "2026-09-10")
        XCTAssertTrue(index.event(id: "a")?.isRecurring ?? false)
        XCTAssertFalse(index.event(id: "b")?.isRecurring ?? true)
    }

    func testRetitleIsASeriesWidePatchAndRetitlesEveryStub() throws {
        let index = try index()
        let edit = ScheduleEdit.retitle(try XCTUnwrap(index.event(id: "a__2026-09-08")), title: "Bench")
        let endpoint = edit.endpoint()
        XCTAssertEqual(endpoint.method, .patch)
        XCTAssertEqual(endpoint.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/events?id=a")
        XCTAssertEqual(body(endpoint), #"{"fields":{"title":"Bench"},"log":{"event_date":"2026-09-08","event_title":"Bench","triggered_by":"user"}}"#)
        let next = edit.apply(to: index)
        XCTAssertEqual(next.event(id: "a")?.title, "Bench")
        XCTAssertEqual(next.event(id: "a__2026-09-15")?.title, "Bench")
        XCTAssertEqual(next.event(id: "b")?.title, "Run")
    }

    func testDifficultyAndSectionsPatchOnlyWhatChanged() throws {
        let index = try index()
        let event = try XCTUnwrap(index.event(id: "a"))
        XCTAssertEqual(body(ScheduleEdit.setDifficulty(event, 5).endpoint()),
                       #"{"fields":{"difficulty":5},"log":{"event_date":"2026-09-01","event_title":"Zed","triggered_by":"user"}}"#)
        let sections = ScheduleEdit.setSections(event, warmup: [], exercises: nil, cooldown: nil)
        XCTAssertEqual(body(sections.endpoint()), #"{"fields":{"warmup":[]},"log":{"event_date":"2026-09-01","event_title":"Zed","triggered_by":"user"}}"#)
        let next = sections.apply(to: index)
        XCTAssertEqual(next.event(id: "a")?.base.warmup, [])
        XCTAssertEqual(next.event(id: "a")?.base.exercises?.count, 1)
        XCTAssertEqual(ScheduleEdit.setDifficulty(event, 5).apply(to: index).event(id: "a__2026-09-15")?.base.difficulty, 5)
    }

    func testRescheduleOneOffPatchesDateAndTimesAndMovesTheDay() throws {
        let index = try index()
        let edit = ScheduleEdit.reschedule(try XCTUnwrap(index.event(id: "b")), OccurrenceOverride(date: "2026-09-12", startTime: "7:00 AM"))
        let endpoint = edit.endpoint()
        XCTAssertEqual(endpoint.url(relativeTo: base)?.query, "id=b")
        XCTAssertEqual(body(endpoint), #"{"fields":{"date":"2026-09-12","start_time":"7:00 AM"},"log":{"event_date":"2026-09-12","event_title":"Run","triggered_by":"user"}}"#)
        let next = edit.apply(to: index)
        XCTAssertEqual(next.events(on: DayKey("2026-09-10")!), [])
        XCTAssertEqual(next.events(on: DayKey("2026-09-12")!).map(\.id), ["b"])
        XCTAssertEqual(next.event(id: "b")?.startTime, "7:00 AM")
        XCTAssertEqual(next.event(id: "b")?.endTime, "7:15 AM")
    }

    func testRescheduleRecurringOccurrenceSendsTheFullTripleKeyedAtTheOriginalDate() throws {
        let index = try index()
        let edit = ScheduleEdit.reschedule(try XCTUnwrap(index.event(id: "a__2026-09-15")), OccurrenceOverride(startTime: "6:00 AM"))
        let endpoint = edit.endpoint()
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "api/event-instances")
        // The stub inherits the base's end time; the triple sends what the day shows.
        XCTAssertEqual(body(endpoint), #"{"date":"2026-09-15","eventId":"a","eventTitle":"Zed","overrides":{"date":"2026-09-15","endTime":"18:30","startTime":"6:00 AM"},"triggeredBy":"user"}"#)
        let next = edit.apply(to: index)
        XCTAssertEqual(next.event(id: "a__2026-09-15")?.startTime, "6:00 AM")
        XCTAssertEqual(next.event(id: "a__2026-09-08")?.startTime, "17:30")

        // The moved anchor: keyed at its row date, the end time carried along.
        let anchor = ScheduleEdit.reschedule(try XCTUnwrap(index.event(id: "a")), OccurrenceOverride(date: "2026-09-02"))
        XCTAssertEqual(body(anchor.endpoint()), #"{"date":"2026-08-25","eventId":"a","eventTitle":"Zed","overrides":{"date":"2026-09-02","endTime":"18:30","startTime":"17:30"},"triggeredBy":"user"}"#)
        XCTAssertEqual(anchor.apply(to: index).events(on: DayKey("2026-09-02")!).map(\.id), ["a"])
    }

    func testSkipOccurrenceDropsOneStubAndKeepsTheSiblings() throws {
        let index = try index()
        let edit = ScheduleEdit.skipOccurrence(try XCTUnwrap(index.event(id: "a__2026-09-08")))
        XCTAssertEqual(body(edit.endpoint()), #"{"date":"2026-09-08","eventId":"a","eventTitle":"Zed","triggeredBy":"user"}"#)
        let next = edit.apply(to: index)
        XCTAssertNil(next.event(id: "a__2026-09-08"))
        XCTAssertNotNil(next.event(id: "a"))
        XCTAssertNotNil(next.event(id: "a__2026-09-15"))
        XCTAssertEqual(edit.failureToast, "Failed to delete — try again")
    }

    func testDeleteEventDropsTheBaseAndEveryStub() throws {
        let index = try index()
        let edit = ScheduleEdit.deleteEvent(try XCTUnwrap(index.event(id: "a__2026-09-15")))
        let endpoint = edit.endpoint()
        XCTAssertEqual(endpoint.method, .delete)
        XCTAssertEqual(endpoint.url(relativeTo: base)?.query, "id=a")
        XCTAssertEqual(body(endpoint), #"{"log":{"event_date":"2026-09-15","event_title":"Zed","triggered_by":"user"}}"#)
        let next = edit.apply(to: index)
        XCTAssertEqual(next.count, 1)
        XCTAssertNotNil(next.event(id: "b"))
        XCTAssertEqual(ScheduleEdit.retitle(try XCTUnwrap(index.event(id: "b")), title: "x").failureToast, "Failed to save — try again")
    }

    func testInsertingUpsertsInsideTheWindowAndIgnoresTheOutside() throws {
        let index = try index()
        var base = try XCTUnwrap(index.event(id: "b")).base
        base.id = "ai-new"
        base.title = "New"
        let inside = index.inserting(base: base, occurrence: Occurrence(id: "ai-new", baseId: "ai-new", date: "2026-09-10", originalDate: "2026-09-10", startTime: "5:00 AM"))
        XCTAssertEqual(inside.events(on: DayKey("2026-09-10")!).map(\.id), ["ai-new", "b"])
        XCTAssertEqual(inside.event(id: "ai-new")?.keyDate, "2026-09-10")
        let outside = index.inserting(base: base, occurrence: Occurrence(id: "ai-new", baseId: "ai-new", date: "2026-11-01"))
        XCTAssertEqual(outside, index)
        // Removing the last stub of a base drops the base with it.
        XCTAssertEqual(index.removing(occurrenceId: "b").response.bases.map(\.id), ["a"])
    }
}
