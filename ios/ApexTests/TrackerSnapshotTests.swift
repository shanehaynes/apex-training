import ApexCore
import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/TrackerSnapshotTests test
final class TrackerSnapshotTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    private final class FixtureTransport: HTTPTransport, @unchecked Sendable {
        var finished = false
        var offline = false
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            if offline { throw URLError(.notConnectedToInternet) }
            let path = request.url?.path ?? ""
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let name: String
            switch (path, body?["action"] as? String) {
            case ("/api/workout-sessions", "bootstrap"): name = finished ? "bootstrap.json" : "bootstrap-peek.json"
            case ("/api/workout-sessions", "finish"): name = "finish.json"
            case ("/api/coach-summary", _): name = "coach-summary.ndjson"
            default: return HTTPResponse(status: 200, headers: [:], body: Data(#"{"ok":true}"#.utf8))
            }
            var data = try Data(contentsOf: fixtures.appendingPathComponent(name))
            if name == "bootstrap-peek.json" {
                var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                object["session"] = ["id": "s", "user_id": "u", "event_id": "ios-fixture-weekly__2026-09-22", "event_date": "2026-09-22",
                                     "started_at": "2026-09-22T11:18:00.000Z"]
                data = try JSONSerialization.data(withJSONObject: object)
            }
            return HTTPResponse(status: 200, headers: [:], body: data)
        }
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    /// The tracked occurrence, optionally as a scored template.
    private static func event(scoring: String? = nil) -> ScheduleEvent {
        var object = try! JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("schedule.json"))) as! [String: Any]
        if let scoring {
            object["bases"] = (object["bases"] as! [[String: Any]]).map { base in
                guard base["id"] as? String == "ios-fixture-weekly" else { return base }
                var scored = base
                scored["templateId"] = "wt-murph"
                scored["scoringType"] = scoring
                scored["timeCapMinutes"] = 20
                return scored
            }
        }
        let schedule = try! JSONDecoder().decode(ScheduleResponse.self, from: try! JSONSerialization.data(withJSONObject: object))
        return ScheduleIndex(schedule).events(on: DayKey("2026-09-22")!).first { $0.id == "ios-fixture-weekly__2026-09-22" }!
    }

    @MainActor
    private func model(finished: Bool = false, scoring: String? = nil) async -> (TrackerModel, FixtureTransport) {
        ApexFonts.register()
        let transport = FixtureTransport()
        transport.finished = finished
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        let clock = TestClock(now: Date(timeIntervalSince1970: 1_790_080_920))  // 12:42 on the fixture day
        let queue = WriteQueue(store: MemoryWriteQueueStore(), client: client, clock: clock)
        let deps = TrackerDependencies(
            services: TrackerServices(client: client, cache: MemoryCacheStore(), queue: queue, clock: clock),
            definitions: { [] },
            onCompletionChanged: { _, _, _ in }
        )
        let model = TrackerModel(event: Self.event(scoring: scoring), deps: deps)
        await model.open()
        return (model, transport)
    }

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    @MainActor
    func testTrackerScreen() async {
        let (model, _) = await model()
        snapshot(TrackerScreen(model: model, onClose: {}), named: "tracker")
    }

    @MainActor
    func testTrackerScreenNarrowAndWide() async {
        let (model, _) = await model()
        snapshot(TrackerScreen(model: model, onClose: {}), named: "tracker-16e", size: CGSize(width: 390, height: 844))
        snapshot(TrackerScreen(model: model, onClose: {}), named: "tracker-pro-max", size: CGSize(width: 440, height: 956))
    }

    @MainActor
    func testTrackerScreenLargeType() async {
        let (model, _) = await model()
        snapshot(TrackerScreen(model: model, onClose: {}).environment(\.sizeCategory, .extraExtraLarge), named: "tracker-xxl")
    }

    @MainActor
    func testTrackerFinished() async {
        let (model, _) = await model(finished: true)
        snapshot(TrackerScreen(model: model, onClose: {}), named: "tracker-finished")
    }

    @MainActor
    func testUnloggedConfirmBar() async {
        let (model, _) = await model()
        await model.requestFinish()
        snapshot(TrackerScreen(model: model, onClose: {}), named: "confirm-unlogged")
    }

    @MainActor
    func testCancelConfirmBar() async {
        let (model, _) = await model()
        model.confirmCancel()
        snapshot(TrackerScreen(model: model, onClose: {}), named: "confirm-cancel")
    }

    @MainActor
    func testScoreCards() async {
        let (forTime, _) = await model(scoring: "for-time")
        snapshot(TrackerPreviews.scoreCard(model: forTime), named: "score-for-time", size: CGSize(width: 393, height: 260))
        let (amrap, _) = await model(scoring: "amrap")
        snapshot(TrackerPreviews.scoreCard(model: amrap), named: "score-amrap", size: CGSize(width: 393, height: 260))
    }

    @MainActor
    func testSummaryStates() async throws {
        let (model, _) = await model()
        await model.requestFinish(force: true)
        let deadline = Date().addingTimeInterval(2)
        while model.summary?.coachStatus != .ready, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        snapshot(TrackerScreen(model: model, onClose: {}), named: "summary-with-pr")

        let (offline, transport) = await self.model()
        transport.offline = true
        await offline.requestFinish(force: true)
        snapshot(TrackerScreen(model: offline, onClose: {}), named: "summary-pending-sync")

        let unavailable = TrackerModel.Summary(
            prs: [], scoreRecord: nil, score: nil, coachText: nil,
            coachStatus: .unavailable(TrackerModel.coachUnavailable), pendingSync: false, durationSeconds: 1500
        )
        snapshot(TrackerPreviews.summary(model: model, summary: unavailable), named: "summary-coach-unavailable")
    }

    /// Planned · shadow · logged · extra · a cardio card with one ghost, plus a
    /// pending-sync strip once an edit is queued offline.
    @MainActor
    func testExerciseCards() async {
        let (model, transport) = await model()
        model.addSet(section: "exercise", exerciseId: "fx-press")
        snapshot(TrackerPreviews.exerciseCards(model: model), named: "exercise-cards", size: CGSize(width: 393, height: 520))

        transport.offline = true
        model.focusSet(at: SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 2))
        await model.flushEdits()
        snapshot(TrackerScreen(model: model, onClose: {}), named: "tracker-pending-sync")
    }
}
