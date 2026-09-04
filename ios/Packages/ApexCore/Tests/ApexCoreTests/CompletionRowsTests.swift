import XCTest
@testable import ApexCore

final class CompletionRowsTests: XCTestCase {
    // The server's allowlists, copied literally from api/_lib/allowlist.ts.
    // If either side changes, this test is what says so.
    private let completionColumns: Set<String> = ["event_id", "event_date", "event_type", "event_title", "duration_minutes", "is_completed", "completed_at"]
    private let logColumns: Set<String> = ["event_id", "event_date", "event_type", "event_title", "duration_minutes", "action"]

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
