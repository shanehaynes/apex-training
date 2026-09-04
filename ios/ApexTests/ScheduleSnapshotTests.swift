import ApexCore
import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate.
///
/// Snapshot bytes are a function of the OS's own text rendering and chrome, so a
/// suite recorded on this Mac goes red on a CI runner for reasons that have
/// nothing to do with the change under review — and a permanently red suite is a
/// suite everybody learns to ignore. A Mac session records and reviews these;
/// ios/scripts/screenshots.sh produces the visual evidence a PR carries.
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... test
final class ScheduleSnapshotTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    /// Everything answered from the fixtures, "today" fixed to the fixture day.
    private final class FixtureTransport: HTTPTransport, @unchecked Sendable {
        let empty: Bool
        init(empty: Bool) { self.empty = empty }
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let path = request.url?.path ?? ""
            let name: String
            switch path {
            case "/api/schedule": name = empty ? "schedule-empty.json" : "schedule.json"
            case "/api/profile": name = "profile.json"
            case "/api/query": name = "query-get_meals.json"
            default: return HTTPResponse(status: 200, headers: [:], body: Data(#"{"ok":true}"#.utf8))
            }
            return HTTPResponse(status: 200, headers: [:], body: try Data(contentsOf: fixtures.appendingPathComponent(name)))
        }
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    private struct Streams: ActivityStreamsReading {
        func record(eventId: String, eventDate: String) async throws -> ActivityStreamRecord? {
            guard eventId == "ios-fixture-run" else { return nil }
            return try JSONDecoder().decode([ActivityStreamRecord].self, from: Data(contentsOf: fixtures.appendingPathComponent("activity-streams.json"))).first
        }
    }

    @MainActor
    private func model(empty: Bool = false, today: String = "2026-09-08") async -> ScheduleModel {
        ApexFonts.register()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: FixtureTransport(empty: empty), tokens: Tokens())
        let clock = TestClock(now: DayKey(today)!.utcMidnight.addingTimeInterval(12 * 3600))
        let model = ScheduleModel(deps: ScheduleDependencies(
            client: client, cache: MemoryCacheStore(), clock: clock, streams: Streams(), realtime: nil,
            timeZone: TimeZone(identifier: "UTC")!, firstWeekday: 2
        ))
        await model.start()
        return model
    }

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    @MainActor
    func testDayWithFourEvents() async {
        let model = await model()
        snapshot(ScheduleTab(model: model), named: "day")
    }

    @MainActor
    func testDayEmpty() async {
        let model = await model(empty: true, today: "2026-11-03")
        snapshot(ScheduleTab(model: model), named: "day-empty")
    }

    @MainActor
    func testDayLargeType() async {
        let model = await model()
        snapshot(ScheduleTab(model: model).environment(\.sizeCategory, .extraExtraLarge), named: "day-xxl")
    }

    @MainActor
    func testMonth() async {
        let model = await model()
        model.mode = .month
        snapshot(ScheduleTab(model: model), named: "month")
    }

    @MainActor
    func testDaySheet() async {
        let model = await model()
        snapshot(DaySheet(model: model, day: DayKey("2026-09-08")!, onOpenEvent: { _ in }, onClose: {}), named: "day-sheet", size: CGSize(width: 393, height: 600))
    }

    @MainActor
    func testEventSheetSyncedRun() async {
        let model = await model()
        _ = await model.streams(for: model.event(id: "ios-fixture-run")!)
        snapshot(EventSheet(model: model, eventId: "ios-fixture-run", onClose: {}), named: "event-run", size: CGSize(width: 393, height: 760))
    }

    @MainActor
    func testEventSheetCrag() async {
        let model = await model()
        snapshot(EventSheet(model: model, eventId: "ios-fixture-crag", onClose: {}), named: "event-crag", size: CGSize(width: 393, height: 760))
    }

    @MainActor
    func testEventSheetCircuit() async {
        let model = await model()
        snapshot(EventSheet(model: model, eventId: "ios-fixture-circuit", onClose: {}), named: "event-circuit", size: CGSize(width: 393, height: 760))
    }

    @MainActor
    func testSignInScreen() {
        ApexFonts.register()
        let view = SignInView(onSignIn: { _, _ in nil }, onForgotPassword: { _ in nil })
        assertSnapshot(of: view, as: .image(layout: .device(config: .iPhone13Pro)))
    }
}
