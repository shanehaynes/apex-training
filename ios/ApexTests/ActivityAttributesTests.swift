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

    func testTapURLIsTheCustomSchemeTrackerRoute() {
        let url = TrackerActivityURL.make(eventId: "ios-fixture-weekly__2026-09-22", eventDate: "2026-09-22")
        XCTAssertEqual(url.absoluteString, "apextraining://app/tracker/ios-fixture-weekly__2026-09-22/2026-09-22")
        XCTAssertEqual(url.scheme, DeepLink.scheme)
    }
}
