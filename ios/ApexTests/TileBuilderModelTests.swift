import ApexCore
import XCTest
import ApexFeatures

/// The tile builder against a scripted transport: the debounced preview and
/// its problem slot, the catalog's dimming reasons, the measure reset, Save
/// through the draft body in both outcomes, the coach's reduce landing on
/// the form, dirty tracking.
final class TileBuilderModelTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    private static func fixture(_ name: String) -> Data {
        try! Data(contentsOf: fixtures.appendingPathComponent(name))
    }

    private static let fixtureNow = Date(timeIntervalSince1970: 1_788_868_800)

    private struct Recorded: Equatable { let method: String; let path: String; let body: String? }

    /// Answers per route, consumed in order; the last one repeats.
    private final class Transport: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var routes: [String: [(Int, Data)]] = [:]
        private(set) var requests: [Recorded] = []
        var delay: Duration = .zero

        func set(_ method: String, _ path: String, status: Int = 200, body: Data = Data(#"{"ok":true}"#.utf8)) {
            lock.lock(); routes["\(method) \(path)"] = [(status, body)]; lock.unlock()
        }

        func set(_ method: String, _ path: String, bodies: [Data]) {
            lock.lock(); routes["\(method) \(path)"] = bodies.map { (200, $0) }; lock.unlock()
        }

        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            let recorded = Recorded(method: request.httpMethod ?? "GET", path: request.url?.path ?? "",
                                    body: request.httpBody.map { String(decoding: $0, as: UTF8.self) })
            let answer: (Int, Data)? = lock.withLock {
                requests.append(recorded)
                guard var queue = routes[key], let head = queue.first else { return nil }
                if queue.count > 1 { queue.removeFirst(); routes[key] = queue }
                return head
            }
            if delay > .zero { try await Task.sleep(for: delay) }
            guard let (status, body) = answer else { throw APIError.network("no route for \(key)") }
            return HTTPResponse(status: status, headers: ["Content-Type": key.hasSuffix("chat") ? "application/x-ndjson" : "application/json"], body: body)
        }

        func count(_ method: String, _ path: String) -> Int {
            lock.lock(); defer { lock.unlock() }
            return requests.filter { $0.method == method && $0.path == path }.count
        }

        func body(_ method: String, _ path: String) -> String? {
            lock.lock(); defer { lock.unlock() }
            return requests.last { $0.method == method && $0.path == path }?.body
        }
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    private func transport() -> Transport {
        let t = Transport()
        t.set("GET", "/api/analytics-tiles", body: Self.fixture("analytics-tiles.json"))
        t.set("POST", "/api/analytics-compute", body: Self.fixture("analytics-compute.json"))
        t.set("POST", "/api/analytics-tiles", body: Self.fixture("analytics-tiles-save.json"))
        // The fixture profile has no key; the coach tests want the composer open.
        t.set("GET", "/api/profile", body: Data(String(decoding: Self.fixture("profile.json"), as: UTF8.self)
            .replacingOccurrences(of: "\"hasAnthropicKey\": false", with: "\"hasAnthropicKey\": true").utf8))
        t.set("POST", "/api/chat", bodies: [
            Self.fixture("chat-stream-analytics.ndjson"),
            Data("{\"type\":\"text\",\"delta\":\"Set up weekly tonnage. Review the form and press Save.\"}\n{\"type\":\"done\"}\n".utf8),
        ])
        t.set("POST", "/api/coach-tool", body: Self.fixture("coach-tool-chart-draft.json"))
        return t
    }

    @MainActor
    private func analytics(_ transport: Transport) async -> (AnalyticsModel, ApexClient, TestClock) {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        let clock = TestClock(now: Self.fixtureNow)
        let model = AnalyticsModel(deps: AnalyticsDependencies(client: client, cache: MemoryCacheStore(), clock: clock, realtime: nil, timeZone: TimeZone(identifier: "UTC")!))
        await model.start()
        return (model, client, clock)
    }

    /// A builder with no settle time: every edit previews at once.
    @MainActor
    private func builder(_ transport: Transport, tile: AnalyticsTile? = nil, coach: Bool = false) async -> (TileBuilderModel, AnalyticsModel) {
        let (model, client, clock) = await analytics(transport)
        let services = coach ? CoachServices(client: client, store: MemoryConversationStore(), clock: clock, timeZone: TimeZone(identifier: "UTC")!) : nil
        let builder = TileBuilderModel(model: model, tile: tile, coachServices: services)
        builder.previewDelay = .zero
        await builder.start()
        return (builder, model)
    }

    /// Lets the preview task run to its answer.
    @MainActor
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(30))
    }

    private static let preview = try! JSONEncoder().encode(
        try! JSONDecoder().decode(AnalyticsComputeResponse.self, from: fixture("analytics-compute-preview.json"))
    )

    // MARK: - Preview

    @MainActor
    func testAnEmptyDraftPreviewsAsTheServersProblemAndAMeasurePreviewsData() async throws {
        let t = transport()
        t.set("POST", "/api/analytics-compute", bodies: [Self.fixture("analytics-compute.json"), Self.preview, Self.fixture("analytics-compute.json")])
        let (builder, _) = await builder(t)
        await settle()
        // The dashboard's compute, then the builder's first preview: a draft with no measure.
        XCTAssertEqual(t.count("POST", "/api/analytics-compute"), 2)
        XCTAssertEqual(builder.preview, .problem("Every series needs a measure."))
        let body = try XCTUnwrap(t.body("POST", "/api/analytics-compute"))
        XCTAssertTrue(body.hasPrefix(#"{"drafts":[{"#), body)
        XCTAssertTrue(body.contains(#""today":"2026-09-08""#), body)

        builder.setMeasure("s1", "tonnage")
        await settle()
        XCTAssertEqual(t.count("POST", "/api/analytics-compute"), 3)
        guard case .ready(let data) = builder.preview else { return XCTFail("\(builder.preview)") }
        XCTAssertEqual(data.series.first?.label, "Sessions")   // the fixture's first slot
        XCTAssertTrue(builder.isDirty)
    }

    @MainActor
    func testEditsInsideTheSettleTimeCollapseIntoOnePreview() async throws {
        let t = transport()
        let (builder, _) = await builder(t)
        await settle()
        let before = t.count("POST", "/api/analytics-compute")
        builder.previewDelay = .milliseconds(60)
        builder.update { $0.title = "A" }
        builder.update { $0.title = "AB" }
        builder.update { $0.title = "ABC" }
        XCTAssertEqual(t.count("POST", "/api/analytics-compute"), before, "nothing fires before the draft settles")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(t.count("POST", "/api/analytics-compute"), before + 1)
        XCTAssertTrue(try XCTUnwrap(t.body("POST", "/api/analytics-compute")).contains(#""title":"ABC""#))
    }

    @MainActor
    func testAnUnchangedEditPreviewsNothing() async throws {
        let t = transport()
        let (builder, _) = await builder(t)
        await settle()
        let before = t.count("POST", "/api/analytics-compute")
        builder.update { $0.title = builder.draft.title }
        await settle()
        XCTAssertEqual(t.count("POST", "/api/analytics-compute"), before)
        XCTAssertFalse(builder.isDirty)
    }

    @MainActor
    func testATransportFailureIsAFailedPreviewNotAProblem() async throws {
        let t = transport()
        let (builder, _) = await builder(t)
        await settle()
        t.set("POST", "/api/analytics-compute", status: 503, body: Data("down".utf8))
        builder.update { $0.title = "x" }
        await settle()
        guard case .failed = builder.preview else { return XCTFail("\(builder.preview)") }
    }

    // MARK: - The catalog's rules

    @MainActor
    func testDimReasonsFollowTheSportBlocklistBothWays() async throws {
        let (builder, _) = await builder(transport())
        XCTAssertNil(builder.measureDimReason(seriesId: "s1", measureId: "distance"))
        builder.toggle("s1", \.sports, "climbing")
        XCTAssertEqual(builder.measureDimReason(seriesId: "s1", measureId: "distance"), "Incompatible with climbing")
        XCTAssertEqual(builder.measureDimReason(seriesId: "s1", measureId: "pitches"), nil)
        XCTAssertNil(builder.measureDimReason(seriesId: "s1", measureId: "tonnage"))
        builder.setMeasure("s1", "distance")
        XCTAssertNil(builder.measureDimReason(seriesId: "s1", measureId: "distance"), "the chosen measure is never dimmed")
        XCTAssertEqual(builder.sportDimReason(seriesId: "s1", sport: "climbing"), "Incompatible with Distance")
        XCTAssertNil(builder.sportDimReason(seriesId: "s1", sport: "running"))
        XCTAssertTrue(builder.showsDisplayUnit)
        let show = builder.filterVisibility(for: builder.draft.series[0])
        XCTAssertTrue(show.sports && show.logs && show.eventTypes && !show.meals)
        builder.setMeasure("s1", "calories")
        let meals = builder.filterVisibility(for: builder.draft.series[0])
        XCTAssertTrue(meals.meals && !meals.sports && !meals.logs && !meals.eventTypes)
        XCTAssertFalse(builder.showsDisplayUnit)
    }

    @MainActor
    func testSettingAMeasureResetsAggregationAndSplitAndAKPIHidesTheBucket() async throws {
        let (builder, _) = await builder(transport())
        builder.setMeasure("s1", "tonnage")
        builder.updateSeries("s1") { $0.agg = "avg"; $0.groupBy = "exercise" }
        builder.setMeasure("s1", "distance")
        XCTAssertEqual(builder.draft.series[0].agg, "")
        XCTAssertEqual(builder.draft.series[0].groupBy, "")
        XCTAssertTrue(builder.showsBucket)
        builder.update { $0.chartType = "kpi" }
        XCTAssertFalse(builder.showsBucket)
        builder.setExerciseNames("s1", text: " Bench Press, Squat ,, ")
        XCTAssertEqual(builder.draft.series[0].exerciseNames, ["Bench Press", "Squat"])
        builder.addSeries()
        XCTAssertEqual(builder.draft.series.map(\.id), ["s1", "s2"])
        builder.removeSeries("s1")
        XCTAssertEqual(builder.draft.series.map(\.id), ["s2"])
    }

    // MARK: - Save

    @MainActor
    func testSaveRefusedByTheServerLeavesTheFormAndTheDashboardAlone() async throws {
        let t = transport()
        t.set("POST", "/api/analytics-tiles", body: Data(#"{"ok":false,"problem":"Give the tile a title"}"#.utf8))
        let (builder, model) = await builder(t)
        let before = model.tiles.count
        let saved = await builder.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(model.tiles.count, before)
        XCTAssertTrue(builder.isDirty == false)
    }

    @MainActor
    func testSaveOfANewTilePostsTheDraftFullWidthAtTheBottomAndLandsOnTheDashboard() async throws {
        let t = transport()
        let (builder, model) = await builder(t)
        builder.update { $0.title = "Weekly tonnage" }
        builder.setMeasure("s1", "tonnage")
        await settle()
        // The server lists the new tile from now on.
        let listed = try JSONDecoder().decode(AnalyticsTilesResponse.self, from: Self.fixture("analytics-tiles.json"))
        let savedTile = try XCTUnwrap(try JSONDecoder().decode(TileSaveResponse.self, from: Self.fixture("analytics-tiles-save.json")).tile)
        t.set("GET", "/api/analytics-tiles", body: try JSONEncoder().encode(AnalyticsTilesResponse(tiles: listed.tiles + [savedTile], options: listed.options)))
        let saved = await builder.save()
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(t.body("POST", "/api/analytics-tiles"))
        XCTAssertTrue(body.hasPrefix(#"{"draft":{"bucket":"week","chartType":"line""#), body)
        XCTAssertTrue(body.contains(#""id":"tile-"#), body)
        XCTAssertTrue(body.hasSuffix(#""layout":{"h":4,"w":12,"x":0,"y":24}}"#), body)
        XCTAssertFalse(builder.isDirty)
        // The server's tile is on the dashboard, and the dashboard re-read.
        XCTAssertTrue(model.tiles.contains { $0.id == "ios-fixture-tile-save" })
        XCTAssertEqual(t.count("GET", "/api/analytics-tiles"), 2)
    }

    @MainActor
    func testEditingKeepsTheTilesIdAndLayout() async throws {
        let t = transport()
        let (model, _, _) = await analytics(t)
        let tile = model.tiles[1]   // tonnage, x 0 y 4 w 6 h 4
        let builder = TileBuilderModel(model: model, tile: tile)
        builder.previewDelay = .zero
        XCTAssertEqual(builder.title, "Edit tile")
        XCTAssertEqual(builder.draft.title, "Tonnage")
        XCTAssertFalse(builder.isDirty)
        builder.update { $0.title = "Tonnage, weekly" }
        XCTAssertTrue(builder.isDirty)
        let saved = await builder.save()
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(t.body("POST", "/api/analytics-tiles"))
        XCTAssertTrue(body.contains(#""id":"ios-fixture-tile-tonnage""#), body)
        XCTAssertTrue(body.hasSuffix(#""layout":{"h":4,"w":6,"x":0,"y":4}}"#), body)
    }

    // MARK: - The coach

    @MainActor
    func testTheCoachsReduceLandsOnTheFormAndPreviewsAgain() async throws {
        let t = transport()
        let (builder, _) = await builder(t, coach: true)
        await settle()
        let coach = try XCTUnwrap(builder.coach)
        XCTAssertEqual(coach.mode, .analytics)
        XCTAssertEqual(coach.composerPlaceholder, "e.g. “Weekly running mileage, last 3 months”")
        let before = t.count("POST", "/api/analytics-compute")
        coach.composerText = "weekly tonnage as bars"
        await coach.send().value
        await settle()
        XCTAssertEqual(t.count("POST", "/api/chat"), 2)
        XCTAssertEqual(t.count("POST", "/api/coach-tool"), 1)
        XCTAssertEqual(builder.draft.title, "Fixture weekly tonnage")
        XCTAssertEqual(builder.draft.chartType, "bar")
        XCTAssertEqual(builder.draft.series.first?.measure, "tonnage")
        XCTAssertTrue(builder.isDirty)
        XCTAssertGreaterThan(t.count("POST", "/api/analytics-compute"), before, "the reduced draft previews")
        // The reduce started from the form's draft (the web's draftRef rule).
        XCTAssertTrue(try XCTUnwrap(t.body("POST", "/api/coach-tool")).contains(#""name":"update_chart_draft""#))
    }
}
