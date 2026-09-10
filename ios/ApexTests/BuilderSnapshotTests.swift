import ApexCore
import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate (see ScheduleSnapshotTests).
final class BuilderSnapshotTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1", "set APEX_SNAPSHOTS=1 to run snapshot tests")
    }

    private final class FixtureTransport: HTTPTransport, @unchecked Sendable {
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let name: String
            switch request.url?.path ?? "" {
            case "/api/schedule": name = "schedule.json"
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

    @MainActor
    private func builder(_ route: BuilderRoute, coach: Bool = false) async -> BuilderModel {
        ApexFonts.register()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: FixtureTransport(), tokens: Tokens())
        let clock = TestClock(now: Date(timeIntervalSince1970: 1_788_868_800))
        let model = ScheduleModel(deps: ScheduleDependencies(
            client: client, cache: MemoryCacheStore(), clock: clock, streams: nil, realtime: nil,
            timeZone: TimeZone(identifier: "UTC")!, firstWeekday: 2, prefetchesTracker: false
        ))
        await model.start()
        let services = coach ? CoachServices(client: client, store: MemoryConversationStore(), clock: clock, timeZone: TimeZone(identifier: "UTC")!) : nil
        let builder = BuilderModel(model: model, route: route, coachServices: services)
        await builder.start()
        return builder
    }

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    @MainActor
    func testTemplateSearch() async {
        let builder = await builder(.create(date: DayKey("2026-09-10")!))
        snapshot(BuilderSheet(builder: builder, onClose: {}), named: "search")
    }

    @MainActor
    func testFormFromTheTemplate() async {
        let builder = await builder(.create(date: DayKey("2026-09-10")!))
        builder.pick(builder.templates[0])
        snapshot(BuilderSheet(builder: builder, onClose: {}), named: "form-template", size: CGSize(width: 393, height: 1400))
    }

    @MainActor
    func testFormOutdoorClimbingWithRepeat() async {
        let builder = await builder(.create(date: DayKey("2026-09-10")!))
        builder.query = "Ragged Mountain"
        builder.startBlank()
        builder.setType(.outdoorClimbing)
        builder.update { $0.repeatRule = DraftRepeat(enabled: true, days: [.saturday], interval: "2", until: "2026-12-19") }
        snapshot(BuilderSheet(builder: builder, onClose: {}), named: "form-outdoor-repeat", size: CGSize(width: 393, height: 1400))
    }

    @MainActor
    func testEditingASeriesShowsTheScopeBar() async {
        let builder = await builder(.edit(eventId: "ios-fixture-weekly__2026-09-15"))
        builder.choosingScope = true
        snapshot(BuilderSheet(builder: builder, onClose: {}), named: "scope-bar")
    }

    @MainActor
    func testCoachDrawerEmpty() async {
        let builder = await builder(.create(date: DayKey("2026-09-10")!), coach: true)
        builder.pick(builder.templates[0])
        builder.coachOpen = true
        snapshot(BuilderSheet(builder: builder, onClose: {}), named: "coach-drawer")
    }

    @MainActor
    func testFormLargeType() async {
        let builder = await builder(.create(date: DayKey("2026-09-10")!))
        builder.pick(builder.templates[0])
        snapshot(BuilderSheet(builder: builder, onClose: {}).environment(\.sizeCategory, .extraExtraLarge), named: "form-xxl", size: CGSize(width: 393, height: 1400))
    }
}
