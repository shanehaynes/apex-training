import ApexCore
import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate (see ScheduleSnapshotTests). The W9 dashboard:
/// every chart type over the seeded fixtures, the stat row wrapping on a
/// narrow phone, the table's sticky header, the scrub card, the invalid
/// tile, the empty state, edit mode, and the largest type size.
final class AnalyticsSnapshotTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1", "set APEX_SNAPSHOTS=1 to run snapshot tests")
    }

    private final class FixtureTransport: HTTPTransport, @unchecked Sendable {
        var empty = false
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let name: String
            switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
            case ("GET", "/api/analytics-tiles"):
                if empty { return HTTPResponse(status: 200, headers: [:], body: Data(#"{"tiles":[],"options":{"categories":[],"otherWorkoutTitles":[]}}"#.utf8)) }
                name = "analytics-tiles.json"
            case ("POST", "/api/analytics-compute"):
                // The builder's preview: a draft with no measure is the web's problem.
                if let body = request.httpBody, String(decoding: body, as: UTF8.self).contains("\"measure\":\"\"") {
                    name = "analytics-compute-preview.json"
                } else {
                    name = "analytics-compute.json"
                }
            case ("POST", "/api/analytics-tiles"):
                // The server's blank-title refusal, as the mock and the handler answer it.
                if let body = request.httpBody, String(decoding: body, as: UTF8.self).contains("\"title\":\"\"") {
                    return HTTPResponse(status: 200, headers: [:], body: Data(#"{"ok":false,"problem":"Give the tile a title"}"#.utf8))
                }
                return HTTPResponse(status: 200, headers: [:], body: Data(#"{"ok":true}"#.utf8))
            case ("GET", "/api/profile"): name = "profile.json"
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
    private func model(empty: Bool = false) async -> AnalyticsModel {
        await stack(empty: empty).model
    }

    @MainActor
    private func stack(empty: Bool = false) async -> (model: AnalyticsModel, client: ApexClient, clock: TestClock) {
        ApexFonts.register()
        let transport = FixtureTransport()
        transport.empty = empty
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        let clock = TestClock(now: Date(timeIntervalSince1970: 1_788_868_800))
        let model = AnalyticsModel(deps: AnalyticsDependencies(
            client: client, cache: MemoryCacheStore(), clock: clock, realtime: nil, timeZone: TimeZone(identifier: "UTC")!
        ))
        await model.start()
        return (model, client, clock)
    }

    /// A builder over the seeded dashboard, its first preview settled.
    @MainActor
    private func builder(tile: AnalyticsTile? = nil, coach: Bool = false) async -> TileBuilderModel {
        let (model, client, clock) = await stack()
        let services = coach ? CoachServices(client: client, store: MemoryConversationStore(), clock: clock, timeZone: TimeZone(identifier: "UTC")!) : nil
        let builder = TileBuilderModel(model: model, tile: tile, coachServices: services)
        builder.previewDelay = .zero
        await builder.start()
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(50))
        return builder
    }

    private func data(_ index: Int) throws -> TileData {
        let compute = try JSONDecoder().decode(AnalyticsComputeResponse.self, from: Data(contentsOf: Self.fixtures.appendingPathComponent("analytics-compute.json")))
        guard case .ok(let data) = compute.tiles[index] else { throw XCTSkip("slot \(index) is a problem") }
        return data
    }

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    /// One tile body at the card's medium height, framed like the card.
    @MainActor
    private func card(_ body: some View, height: Double = TileHeight.medium.points) -> some View {
        body.frame(height: height).padding(Spacing.md)
            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
            .padding(Spacing.screen)
    }

    @MainActor
    func testDashboard() async {
        let model = await model()
        snapshot(AnalyticsTab(model: model), named: "dashboard", size: CGSize(width: 393, height: 1400))
    }

    @MainActor
    func testEmptyDashboard() async {
        let model = await model(empty: true)
        snapshot(AnalyticsTab(model: model), named: "empty")
    }

    @MainActor
    func testKPIRowWrapsOnTheSE() async throws {
        // Three stat series on the narrowest phone: the row wraps on purpose (U26).
        let one = try data(0)
        let series = [
            TileData.Series(key: "s1", label: "Sessions", unitKind: "count", unit: "", axis: "left", points: [12]),
            TileData.Series(key: "s2", label: "Training time", unitKind: "minutes", unit: "min", axis: "left", points: [1234.5]),
            TileData.Series(key: "s3", label: "Tonnage", unitKind: "weight", unit: "lb", axis: "left", points: [98_760]),
        ]
        let wide = TileData(buckets: one.buckets, series: series, excluded: one.excluded, rangeLabel: one.rangeLabel)
        snapshot(card(KPIRowView(data: wide)), named: "kpi-se", size: CGSize(width: 375, height: 360))
    }

    @MainActor
    func testBar() async throws {
        snapshot(card(TileChartView(kind: .bar, data: try data(1))), named: "bar", size: CGSize(width: 393, height: 360))
    }

    @MainActor
    func testStackedBarUsesWorkoutTypeColours() async throws {
        snapshot(card(TileChartView(kind: .stackedBar, data: try data(2))), named: "stacked", size: CGSize(width: 393, height: 360))
    }

    @MainActor
    func testTableWithGradeLabels() async throws {
        snapshot(card(TileTableView(data: try data(3))), named: "table", size: CGSize(width: 393, height: 360))
    }

    @MainActor
    func testLineWithAGap() async throws {
        snapshot(card(TileChartView(kind: .line, data: try data(4))), named: "line-gap", size: CGSize(width: 393, height: 360))
    }

    @MainActor
    func testAreaWithAnExcludedEntry() async throws {
        let model = await model()
        let tile = model.tiles[5]
        snapshot(
            TileCardView(tile: tile, result: model.result(for: tile), isComputing: false, onEdit: {}, onDuplicate: {}, onDelete: {})
                .padding(Spacing.screen),
            named: "area-excluded", size: CGSize(width: 393, height: 400)
        )
    }

    @MainActor
    func testTwoSeriesLegendAndRightAxis() async throws {
        let base = try data(1)
        let two = TileData(
            buckets: base.buckets,
            series: [
                base.series[0],
                TileData.Series(key: "s2", label: "Avg heart rate", unitKind: "bpm", unit: "bpm", axis: "right", points: [nil, 150, nil, 148, nil]),
            ],
            excluded: base.excluded, rangeLabel: base.rangeLabel
        )
        snapshot(card(TileChartView(kind: .line, data: two)), named: "two-axes", size: CGSize(width: 393, height: 360))
    }

    @MainActor
    func testInvalidTile() async {
        let tile = AnalyticsTile(id: "tile-old", title: "Old tile", spec: nil, draft: nil, layout: TileLayout(x: 0, y: 0, w: 12, h: 2))
        snapshot(
            TileCardView(tile: tile, result: nil, isComputing: false, onEdit: {}, onDuplicate: {}, onDelete: {}).padding(Spacing.screen),
            named: "invalid", size: CGSize(width: 393, height: 300)
        )
    }

    @MainActor
    func testEditMode() async {
        let model = await model()
        model.beginEdit()
        model.setHeight("ios-fixture-tile-tonnage", .large)
        snapshot(AnalyticsTab(model: model), named: "edit")
    }

    @MainActor
    func testDashboardAtTheLargestType() async {
        let model = await model()
        snapshot(AnalyticsTab(model: model).environment(\.sizeCategory, .extraExtraLarge), named: "dashboard-xxl", size: CGSize(width: 393, height: 1400))
    }

    /// The largest accessibility size (W13): KPI rows wrap, ticks stay legible.
    @MainActor
    func testDashboardAccessibilityXXXL() async {
        let model = await model()
        snapshot(AnalyticsTab(model: model).environment(\.dynamicTypeSize, .accessibility3), named: "dashboard-axxxl", size: CGSize(width: 393, height: 1800))
    }

    // MARK: - The tile builder (PR C)

    @MainActor
    func testBuilderNew() async {
        let builder = await builder()
        snapshot(TileBuilderSheet(builder: builder, onClose: {}), named: "builder-new", size: CGSize(width: 393, height: 1400))
    }

    @MainActor
    func testBuilderEditingTheStackedTile() async {
        let (model, _, _) = await stack()
        let builder = await builder(tile: model.tiles[2])
        snapshot(TileBuilderSheet(builder: builder, onClose: {}), named: "builder-edit", size: CGSize(width: 393, height: 1600))
    }

    @MainActor
    func testBuilderFiltersOpenWithADimmedSport() async {
        let builder = await builder()
        builder.setMeasure("s1", "distance")
        builder.filtersOpen.insert("s1")
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(50))
        snapshot(TileBuilderSheet(builder: builder, onClose: {}), named: "builder-filters", size: CGSize(width: 393, height: 1800))
    }

    @MainActor
    func testBuilderCoachDrawer() async {
        let builder = await builder(coach: true)
        builder.coachOpen = true
        snapshot(TileBuilderSheet(builder: builder, onClose: {}), named: "builder-coach")
    }

    /// Save with no title: the server's refusal is a line above Cancel/Save,
    /// inside the sheet — a toast would render under it.
    @MainActor
    func testBuilderSaveRefused() async {
        let builder = await builder()
        builder.setMeasure("s1", "tonnage")
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(50))
        _ = await builder.save()
        snapshot(TileBuilderSheet(builder: builder, onClose: {}), named: "builder-saveproblem")
    }

    @MainActor
    func testBuilderAtTheLargestType() async {
        let builder = await builder()
        snapshot(TileBuilderSheet(builder: builder, onClose: {}).environment(\.sizeCategory, .extraExtraLarge), named: "builder-xxl", size: CGSize(width: 393, height: 1600))
    }
}
