import XCTest
@testable import ApexCore

/// The W7 write bodies, byte for byte (sorted keys), and the time helpers
/// the sheet's inline edits lean on.
final class WriteEndpointTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:5314")!
    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }

    func testWorkoutDraftBodyCarriesTheDraftTodayAndTheAction() {
        var draft = WorkoutDraft.empty(date: "2026-09-10", title: "Leg day")
        draft.repeatRule = DraftRepeat(enabled: true, days: [.monday], interval: "2", until: "")
        let create = Endpoint.workoutDraft(draft: draft, today: "2026-09-08", action: .create)
        XCTAssertEqual(create.method, .post)
        XCTAssertEqual(create.path, "api/workout-draft")
        let text = body(create)
        XCTAssertTrue(text.hasPrefix(#"{"action":{"kind":"create"},"draft":{"avgHeartRate":"","date":"2026-09-10","description":"","difficulty":3,"distance":"","duration":"60","elevationGain":"","endTime":"","equipment":[],"lists":{"cooldown":[],"exercises":[],"warmup":[]},"location":"","maxGrade":"","repeat":{"days":["MO"],"enabled":true,"interval":"2","until":""},"scoringType":"strength","sport":"","startTime":"","tags":"","timeCap":"","title":"Leg day","totalPitches":"","type":"weights"},"today":"2026-09-08"}"#), text)
        XCTAssertFalse(text.contains("templateId"))
        XCTAssertTrue(body(Endpoint.workoutDraft(draft: draft, today: "d", action: .update(eventId: "a"))).hasPrefix(#"{"action":{"eventId":"a","kind":"update"}"#))
        XCTAssertTrue(body(Endpoint.workoutDraft(draft: draft, today: "d", action: .detach(eventId: "a__2026-09-15", occurrenceDate: "2026-09-15")))
            .hasPrefix(#"{"action":{"eventId":"a__2026-09-15","kind":"detach","occurrenceDate":"2026-09-15"}"#))
    }

    func testCoachToolCarriesTheDraftOnlyWhenGiven() {
        let with = Endpoint.coachTool(toolUseId: "t", name: "update_workout_draft", input: ["title": "L"], today: "d", draft: ["title": "Leg day"])
        XCTAssertEqual(body(with), #"{"draft":{"title":"Leg day"},"input":{"title":"L"},"name":"update_workout_draft","today":"d","toolUseId":"t"}"#)
        XCTAssertEqual(body(Endpoint.coachTool(toolUseId: "t", name: "delete_event", input: ["event_id": "e"], today: "d")),
                       #"{"input":{"event_id":"e"},"name":"delete_event","today":"d","toolUseId":"t"}"#)
    }

    func testArchiveTemplateTogglesArchivedAt() {
        let archive = Endpoint.archiveTemplate(id: "wt-1", archivedAt: "2026-09-08T12:00:00Z")
        XCTAssertEqual(archive.method, .patch)
        XCTAssertEqual(archive.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/workout-templates?id=wt-1")
        XCTAssertEqual(body(archive), #"{"archived_at":"2026-09-08T12:00:00Z"}"#)
        XCTAssertEqual(body(Endpoint.archiveTemplate(id: "wt-1", archivedAt: nil)), #"{"archived_at":null}"#)
    }

    func testCreateDefinitionMintsTheSlugAndUserAttribution() {
        let name = "90/90 Hip Stretch"
        let endpoint = Endpoint.createDefinition(id: Slug.name(name), canonicalName: name, category: "stretch", isUnilateral: true)
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "api/exercise-definitions")
        XCTAssertEqual(body(endpoint), #"{"aliases":[],"canonical_name":"90/90 Hip Stretch","category":"stretch","equipment":[],"id":"90-90-hip-stretch","is_unilateral":true,"muscle_groups":[],"triggered_by":"user"}"#)
    }

    func testEventFieldsOmitNilKeysAndUseSnakeCase() {
        let fields = EventFields(title: "T", date: "2026-09-12", startTime: "7:00 AM", endTime: "8:00 AM")
        let endpoint = Endpoint.updateEvent(id: "a", fields: fields, log: EventMutationLog(eventTitle: "T"))
        XCTAssertEqual(body(endpoint), #"{"fields":{"date":"2026-09-12","end_time":"8:00 AM","start_time":"7:00 AM","title":"T"},"log":{"event_title":"T","triggered_by":"user"}}"#)
    }

    func testTimeHelpersNeverTouchALocale() {
        XCTAssertEqual(TimeLabel.inputTime("5:30 PM"), "17:30")
        XCTAssertEqual(TimeLabel.inputTime("07:05"), "07:05")
        XCTAssertEqual(TimeLabel.inputTime(nil), "")
        XCTAssertEqual(TimeLabel.inputTime("noon"), "")
        XCTAssertEqual(TimeLabel.stored(minutes: 6 * 60 + 30), "6:30 AM")
        XCTAssertEqual(TimeLabel.stored(minutes: 0), "12:00 AM")
        XCTAssertEqual(TimeLabel.stored(minutes: 12 * 60 + 5), "12:05 PM")
        XCTAssertEqual(TimeLabel.stored(minutes: 23 * 60 + 59), "11:59 PM")
        // The stored string is plain ASCII: no narrow no-break space before AM/PM.
        XCTAssertTrue(TimeLabel.stored(minutes: 90).unicodeScalars.allSatisfy { $0.isASCII })
        XCTAssertEqual(TimeLabel.shiftedEnd(newStart: 7 * 60, oldStart: "6:30 AM", oldEnd: "7:15 AM"), 7 * 60 + 45)
        XCTAssertEqual(TimeLabel.shiftedEnd(newStart: 23 * 60 + 30, oldStart: "6:30 AM", oldEnd: "7:15 AM"), 23 * 60 + 59)
        XCTAssertNil(TimeLabel.shiftedEnd(newStart: 7 * 60, oldStart: "6:30 AM", oldEnd: nil))
    }
}
