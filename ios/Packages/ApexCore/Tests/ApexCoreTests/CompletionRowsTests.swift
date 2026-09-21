import XCTest
@testable import ApexCore

final class CompletionRowsTests: XCTestCase {
    // The server's allowlists, copied literally from api/_lib/allowlist.ts.
    // If either side changes, this test is what says so.
    private let completionColumns: Set<String> = ["event_id", "event_date", "event_type", "event_title", "duration_minutes", "is_completed", "completed_at"]
    private let logColumns: Set<String> = ["event_id", "event_date", "event_type", "event_title", "duration_minutes", "action", "client_toggle_id"]

    private func event() throws -> ScheduleEvent {
        let json = """
        {"window":{"start":"2026-09-01","end":"2026-09-30"},
         "bases":[{"id":"a","type":"weights","title":"Push","date":"2026-09-01","estimatedDuration":60}],
         "occurrences":[{"id":"a__2026-09-08","baseId":"a","date":"2026-09-08","startTime":null,"endTime":null,"isCompleted":false,"completedAt":null}]}
        """
        let index = ScheduleIndex(try JSONDecoder().decode(ScheduleResponse.self, from: Data(json.utf8)))
        return try XCTUnwrap(index.event(id: "a__2026-09-08"))
    }

    private func keys(_ data: Data) throws -> Set<String> {
        Set(try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]).keys)
    }

    func testCompleteBuildsBothRowsWithinTheAllowlists() throws {
        let now = Date(timeIntervalSince1970: 1_788_546_600.25) // 2026-09-04T18:30:00.250Z
        let rows = CompletionRows.build(for: try event(), isNowCompleted: true, now: now)
        XCTAssertEqual(rows.completionRow.eventId, "a__2026-09-08")
        XCTAssertEqual(rows.completionRow.eventDate, "2026-09-08")
        XCTAssertEqual(rows.completionRow.eventType, "weights")
        XCTAssertEqual(rows.completionRow.durationMinutes, 60)
        XCTAssertTrue(rows.completionRow.isCompleted)
        XCTAssertEqual(rows.completionRow.completedAt, "2026-09-04T18:30:00.250Z")
        XCTAssertEqual(rows.logRow.action, "complete")

        let encoder = JSONEncoder()
        XCTAssertEqual(try keys(encoder.encode(rows.completionRow)), completionColumns)
        XCTAssertEqual(try keys(encoder.encode(rows.logRow)), logColumns)
    }

    func testUncompleteClearsTheTimestampAndEncodesNulls() throws {
        let rows = CompletionRows.build(for: try event(), isNowCompleted: false, now: Date())
        XCTAssertFalse(rows.completionRow.isCompleted)
        XCTAssertNil(rows.completionRow.completedAt)
        XCTAssertEqual(rows.logRow.action, "uncomplete")
        // Nulls are sent explicitly, like the web's rows; the key set stays whole.
        XCTAssertEqual(try keys(JSONEncoder().encode(rows.completionRow)), completionColumns)
    }

    // The whole point of the id: the queued op carries one value for the life
    // of that toggle, so a replay is recognisable, while the next toggle of
    // the same occurrence to the same action is not mistaken for one.
    func testEachToggleGetsItsOwnIdAndTheQueuedOpKeepsIt() throws {
        let event = try event()
        let first = CompletionRows.build(for: event, isNowCompleted: true, now: Date()).logRow
        let second = CompletionRows.build(for: event, isNowCompleted: true, now: Date()).logRow
        XCTAssertNotNil(first.clientToggleId)
        XCTAssertNotEqual(first.clientToggleId, second.clientToggleId)
        XCTAssertEqual(UUID(uuidString: try XCTUnwrap(first.clientToggleId))?.uuidString.lowercased(),
                       first.clientToggleId)

        let rows = CompletionRows.build(for: event, isNowCompleted: true, now: Date())
        let payload = TrackerOpPayload.completion(completionRow: rows.completionRow, logRow: rows.logRow)
        let replayed = try JSONDecoder().decode(TrackerOpPayload.self, from: try JSONEncoder().encode(payload))
        XCTAssertEqual(replayed, payload)
    }

    /// An op queued by a build from before the column decodes with a nil id
    /// (and the server keeps its old at-least-once behaviour for it).
    func testLogRowFromAnOlderBuildDecodesWithoutTheId() throws {
        let json = """
        {"event_id":"a__2026-09-08","event_date":"2026-09-08","event_type":"weights",
         "event_title":"Push","duration_minutes":60,"action":"complete"}
        """
        let row = try JSONDecoder().decode(CompletionLogRow.self, from: Data(json.utf8))
        XCTAssertNil(row.clientToggleId)
        XCTAssertEqual(row.action, "complete")
    }

    func testEndpointBodies() throws {
        let rows = CompletionRows.build(for: try event(), isNowCompleted: false, now: Date())
        let endpoint = Endpoint.completions(completionRow: rows.completionRow, logRow: rows.logRow)
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "api/completions")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(endpoint.body)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["completionRow", "logRow"])

        let quick = Endpoint.workoutSessions(action: "quick-complete", eventId: "a__2026-09-08", eventDate: "2026-09-08")
        XCTAssertEqual(String(decoding: try XCTUnwrap(quick.body), as: UTF8.self),
                       #"{"action":"quick-complete","eventDate":"2026-09-08","eventId":"a__2026-09-08"}"#)
    }
}
