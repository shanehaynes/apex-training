import ApexActivity
import ApexCore
import XCTest

/// The attributes cross a process boundary (app → extension) as JSON, and the
/// tap URL must be what `DeepLink` parses. Both are cheap to prove here.
final class ActivityAttributesTests: XCTestCase {
    func testAttributesAndStateRoundTrip() throws {
        let attributes = TrackerActivityAttributes(title: "Morning Movement", eventId: "e__2026-09-22", eventDate: "2026-09-22")
        let decoded = try JSONDecoder().decode(TrackerActivityAttributes.self, from: JSONEncoder().encode(attributes))
        XCTAssertEqual(decoded.title, attributes.title)
        XCTAssertEqual(decoded.session, SessionKey(eventId: "e__2026-09-22", eventDate: "2026-09-22"))

        let state = TrackerActivityAttributes.ContentState(
            startedAt: Date(timeIntervalSince1970: 1_790_080_920), exerciseCount: 6, phase: .done(totalSeconds: 2530)
        )
        let decodedState = try JSONDecoder().decode(TrackerActivityAttributes.ContentState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(decodedState, state)
        XCTAssertTrue(decodedState.isDone)
        XCTAssertFalse(TrackerActivityAttributes.ContentState(startedAt: .now).isDone)
    }

    /// A running activity has to go stale on its own: the app that would update
    /// it may be gone (killed mid-workout, or the session finished on the web).
    func testRunningContentGoesStaleFourHoursAfterTheStart() {
        let started = Date(timeIntervalSince1970: 1_790_080_920)
        let running = TrackerActivityAttributes.ContentState(startedAt: started, exerciseCount: 6)
        XCTAssertEqual(LiveActivityController.staleAfter, 4 * 60 * 60)
        XCTAssertEqual(LiveActivityController.staleDate(for: running), started.addingTimeInterval(4 * 60 * 60))

        // A finished total is as true in an hour as it is now.
        let done = TrackerActivityAttributes.ContentState(startedAt: started, phase: .done(totalSeconds: 2530))
        XCTAssertNil(LiveActivityController.staleDate(for: done))
    }

    /// The server's `end` push (api/_lib/services/liveActivity.ts) is decoded
    /// by ActivityKit with a default `JSONDecoder`. A content state that does
    /// not decode is dropped silently on the device, so the server writes the
    /// vector (api/__tests__/live-activity.test.ts) and this proves it lands:
    /// dates as seconds since 2001, `.done` in Swift's synthesized enum shape.
    func testTheServersEndPushDecodes() throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // ApexTests
            .deletingLastPathComponent()  // ios
            .appendingPathComponent("Fixtures/live-activity-end.json")
        let push = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        let aps = try XCTUnwrap(push?["aps"] as? [String: Any])
        XCTAssertEqual(aps["event"] as? String, "end")
        let contentState = try JSONSerialization.data(withJSONObject: XCTUnwrap(aps["content-state"]))

        let state = try JSONDecoder().decode(TrackerActivityAttributes.ContentState.self, from: contentState)
        XCTAssertEqual(state.startedAt, ISO8601DateFormatter().date(from: "2026-09-08T17:00:00Z"))
        XCTAssertEqual(state.phase, .done(totalSeconds: 2712))
        XCTAssertNil(state.exerciseCount)
        XCTAssertTrue(state.isDone)
    }

    func testTapURLIsTheCustomSchemeTrackerRoute() {
        let url = TrackerActivityURL.make(eventId: "ios-fixture-weekly__2026-09-22", eventDate: "2026-09-22")
        XCTAssertEqual(url.absoluteString, "apextraining://app/tracker/ios-fixture-weekly__2026-09-22/2026-09-22")
        XCTAssertEqual(url.scheme, DeepLink.scheme)
    }
}
