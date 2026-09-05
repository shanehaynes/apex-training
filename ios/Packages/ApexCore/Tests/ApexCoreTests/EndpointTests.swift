import XCTest
@testable import ApexCore

final class EndpointTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:5314")!

    func testScheduleURL() {
        let url = Endpoint.schedule(start: "2026-09-01", end: "2026-09-30").url(relativeTo: base)
        XCTAssertEqual(url?.absoluteString, "http://127.0.0.1:5314/api/schedule?start=2026-09-01&end=2026-09-30")
    }

    func testScheduleJoinsIncludes() {
        let url = Endpoint.schedule(start: "a", end: "b", include: ["definitions", "templates"])
            .url(relativeTo: base)
        XCTAssertEqual(url?.query, "start=a&end=b&include=definitions,templates")
    }

    /// The handler is POST-only and reads `{ tool, args }` from the body; keys
    /// are sorted so the same call always produces the same bytes.
    func testQueryIsAPostWithASortedBody() {
        let endpoint = Endpoint.query(tool: "get_meals", args: ["start_date": "2026-09-08", "include_items": true, "limit": 20])
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/query")
        XCTAssertEqual(String(decoding: endpoint.body!, as: UTF8.self),
                       #"{"args":{"include_items":true,"limit":20,"start_date":"2026-09-08"},"tool":"get_meals"}"#)
        XCTAssertEqual(String(decoding: Endpoint.query(tool: "get_prs").body!, as: UTF8.self), #"{"args":{},"tool":"get_prs"}"#)
    }

    func testJSONValueRoundTrips() throws {
        let value: JSONValue = ["a": [1, 2.5, true, nil, "s"], "b": ["c": 3]]
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
    }

    func testTermsAcceptanceIsABodilessPost() {
        XCTAssertEqual(Endpoint.termsAcceptance.method, .post)
        XCTAssertNil(Endpoint.termsAcceptance.body)
        XCTAssertEqual(Endpoint.termsAcceptance.url(relativeTo: base)?.path, "/api/terms-acceptance")
    }

    func testTrailingSlashOnTheBaseDoesNotDoubleUp() {
        let slashed = URL(string: "http://127.0.0.1:5314/")!
        XCTAssertEqual(
            Endpoint.profile.url(relativeTo: slashed)?.absoluteString,
            "http://127.0.0.1:5314/api/profile"
        )
    }
}

// MARK: - W4 tracker bodies

final class TrackerEndpointTests: XCTestCase {
    private let session = SessionKey(eventId: "e1", eventDate: "2026-09-08")

    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }

    func testBootstrapAndPeek() {
        let plain = Endpoint.trackerBootstrap(eventId: "e1", eventDate: "2026-09-08")
        XCTAssertEqual(plain.method, .post)
        XCTAssertEqual(plain.path, "api/workout-sessions")
        XCTAssertEqual(body(plain), #"{"action":"bootstrap","eventDate":"2026-09-08","eventId":"e1"}"#)
        XCTAssertEqual(
            body(Endpoint.trackerBootstrap(eventId: "e1", eventDate: "2026-09-08", startedAt: "2026-09-08T12:00:00.000Z", peek: true)),
            #"{"action":"bootstrap","eventDate":"2026-09-08","eventId":"e1","peek":true,"startedAt":"2026-09-08T12:00:00.000Z"}"#
        )
    }

    func testStartWithAndWithoutAStamp() {
        XCTAssertEqual(body(.tracker(.start(startedAt: "2026-09-08T12:00:00.000Z"), session: session)),
                       #"{"action":"start","eventDate":"2026-09-08","eventId":"e1","startedAt":"2026-09-08T12:00:00.000Z"}"#)
        XCTAssertEqual(body(.tracker(.start(startedAt: nil), session: session)),
                       #"{"action":"start","eventDate":"2026-09-08","eventId":"e1"}"#)
    }

    func testSaveCarriesAllThreeLists() {
        let payload = SavePayload(
            setLogs: [SetLogRow(eventId: "e1", eventDate: "2026-09-08", section: "exercise", exerciseId: "x", exerciseName: "X", setNumber: 1, actualReps: "5")],
            cardioLogs: [CardioLogRow(eventId: "e1", eventDate: "2026-09-08", section: "exercise", exerciseId: "r", exerciseName: "Run", durationMinutes: 42.5, avgHeartRate: 145)],
            removedSets: [SetKey(section: "exercise", exerciseId: "x", setNumber: 4)]
        )
        XCTAssertEqual(
            body(.tracker(.save(payload), session: session)),
            #"{"action":"save","cardioLogs":[{"avg_heart_rate":145,"definition_id":null,"distance":null,"duration_minutes":42.5,"elevation_gain":null,"event_date":"2026-09-08","event_id":"e1","exercise_id":"r","exercise_name":"Run","is_autofilled":false,"section":"exercise"}],"eventDate":"2026-09-08","eventId":"e1","removedSets":[{"exerciseId":"x","section":"exercise","setNumber":4}],"setLogs":[{"actual_duration":null,"actual_reps":"5","actual_weight":null,"definition_id":null,"event_date":"2026-09-08","event_id":"e1","exercise_id":"x","exercise_name":"X","is_autofilled":false,"planned_duration":null,"planned_reps":null,"planned_weight":null,"section":"exercise","set_number":1}]}"#
        )
    }

    func testFinishWithScoreAndWithout() {
        let scored = FinishPayload(
            autofillRows: [], finishedAt: "2026-09-08T12:41:32.000Z",
            score: ScoreSubmission(templateId: "wt-murph", score: .forTime(timeSeconds: 2492))
        )
        XCTAssertEqual(
            body(.tracker(.finish(scored), session: session)),
            #"{"action":"finish","autofillRows":[],"eventDate":"2026-09-08","eventId":"e1","finishedAt":"2026-09-08T12:41:32.000Z","score":{"templateId":"wt-murph","timeSeconds":2492,"type":"for-time"}}"#
        )
        XCTAssertEqual(
            body(.tracker(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), session: session)),
            #"{"action":"finish","autofillRows":[],"eventDate":"2026-09-08","eventId":"e1"}"#
        )
        XCTAssertEqual(
            body(.tracker(.finish(FinishPayload(autofillRows: [], finishedAt: nil, score: ScoreSubmission(templateId: "t", score: .amrap(rounds: 5, reps: 0)))), session: session)),
            #"{"action":"finish","autofillRows":[],"eventDate":"2026-09-08","eventId":"e1","score":{"reps":0,"rounds":5,"templateId":"t","type":"amrap"}}"#
        )
    }

    func testCancelSwapAndCompletion() {
        XCTAssertEqual(body(.tracker(.cancel, session: session)), #"{"action":"cancel","eventDate":"2026-09-08","eventId":"e1"}"#)
        XCTAssertEqual(
            body(.tracker(.swapExercise(SwapPayload(section: "exercise", exerciseId: "x", exerciseName: "Ring Dips", definitionId: "d")), session: session)),
            #"{"action":"swap-exercise","definitionId":"d","eventDate":"2026-09-08","eventId":"e1","exerciseId":"x","exerciseName":"Ring Dips","section":"exercise"}"#
        )
        let rows = CompletionRows.build(
            for: ScheduleIndex(try! TestFixtures.decode(ScheduleResponse.self, "schedule.json")).events(on: DayKey("2026-09-08")!)[0],
            isNowCompleted: true, now: Date(timeIntervalSince1970: 1_788_868_800)
        )
        let completion = Endpoint.tracker(.completion(completionRow: rows.completionRow, logRow: rows.logRow), session: session)
        XCTAssertEqual(completion.path, "api/completions")
        XCTAssertEqual(completion, .completions(completionRow: rows.completionRow, logRow: rows.logRow))
    }

    func testCoachSummary() {
        let endpoint = Endpoint.coachSummary(eventId: "e1", eventDate: "2026-09-08")
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "api/coach-summary")
        XCTAssertEqual(body(endpoint), #"{"eventDate":"2026-09-08","eventId":"e1"}"#)
    }

    func testTrackerOpPayloadRoundTripsThroughJSON() throws {
        let payloads: [TrackerOpPayload] = [
            .start(startedAt: "x"), .start(startedAt: nil), .cancel,
            .save(SavePayload(setLogs: [setRow(1)], removedSets: [SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 2)])),
            .finish(FinishPayload(autofillRows: [setRow(3, weight: "0", reps: "0")], finishedAt: "y",
                                  score: ScoreSubmission(templateId: "t", score: .forTime(timeSeconds: 1)))),
            .swapExercise(SwapPayload(section: "exercise", exerciseId: "x", exerciseName: "Y", definitionId: nil)),
        ]
        for payload in payloads {
            let data = try JSONEncoder().encode(payload)
            XCTAssertEqual(try JSONDecoder().decode(TrackerOpPayload.self, from: data), payload)
        }
    }
}
