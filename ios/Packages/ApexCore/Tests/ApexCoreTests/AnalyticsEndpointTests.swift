import XCTest
@testable import ApexCore

/// The W9 analytics bodies, byte for byte (sorted keys).
final class AnalyticsEndpointTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:5314")!
    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }

    func testTilesIsAPlainGet() {
        let tiles = Endpoint.analyticsTiles
        XCTAssertEqual(tiles.method, .get)
        XCTAssertNil(tiles.body)
        XCTAssertEqual(tiles.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/analytics-tiles")
    }

    func testComputeSendsTheServedSpecsAndToday() {
        let spec: JSONValue = ["version": 1, "title": "Sessions", "chartType": "kpi", "bucket": "total", "series": [["id": "s1", "measure": "session-count"]]]
        let compute = Endpoint.analyticsCompute(specs: [spec], today: "2026-09-12")
        XCTAssertEqual(compute.method, .post)
        XCTAssertEqual(compute.path, "api/analytics-compute")
        XCTAssertEqual(body(compute), #"{"specs":[{"bucket":"total","chartType":"kpi","series":[{"id":"s1","measure":"session-count"}],"title":"Sessions","version":1}],"today":"2026-09-12"}"#)
    }

    func testPreviewWrapsOneDraftInDrafts() {
        var draft = ChartDraft.empty
        draft.title = "Mileage"
        draft.series[0].measure = "distance"
        let preview = Endpoint.analyticsPreview(draft: draft, today: "2026-09-12")
        XCTAssertEqual(preview.path, "api/analytics-compute")
        let text = body(preview)
        XCTAssertTrue(text.hasPrefix(#"{"drafts":[{"bucket":"week","chartType":"line","displayUnit":"","endDate":"","preset":"this-iso-month","rangeKind":"rolling","rollingDays":"90","series":[{"agg":"","axis":"","categories":[],"dayFilterMode":"include","dayFilterOffset":"0","dayFilterTypes":[],"eventTypes":[],"exerciseNames":[],"gradeScale":"","groupBy":"","groupLimit":"","id":"s1","label":"","mealTypes":[],"measure":"distance","sports":[],"workoutTitles":[]}],"startDate":"","title":"Mileage"}],"today":"2026-09-12"}"#), text)
        XCTAssertFalse(text.contains("\"specs\""))
    }

    func testSaveCarriesIdDraftAndLayout() {
        var draft = ChartDraft.empty
        draft.title = "Mileage"
        let save = Endpoint.saveTile(id: "tile-1", draft: draft, layout: TileLayout(x: 0, y: 8, w: 12, h: 4))
        XCTAssertEqual(save.method, .post)
        XCTAssertEqual(save.path, "api/analytics-tiles")
        let text = body(save)
        XCTAssertTrue(text.hasPrefix(#"{"draft":{"bucket":"week""#), text)
        XCTAssertTrue(text.hasSuffix(#""title":"Mileage"},"id":"tile-1","layout":{"h":4,"w":12,"x":0,"y":8}}"#), text)
    }

    func testLayoutsPatchAndDelete() {
        let patch = Endpoint.saveLayouts([TileLayoutUpdate(id: "tile-a", x: 0, y: 0, w: 12, h: 2), TileLayoutUpdate(id: "tile-b", x: 0, y: 2, w: 12, h: 6)])
        XCTAssertEqual(patch.method, .patch)
        XCTAssertEqual(patch.path, "api/analytics-tiles")
        XCTAssertEqual(body(patch), #"{"layouts":[{"h":2,"id":"tile-a","w":12,"x":0,"y":0},{"h":6,"id":"tile-b","w":12,"x":0,"y":2}]}"#)
        let delete = Endpoint.deleteTile(id: "tile-a")
        XCTAssertEqual(delete.method, .delete)
        XCTAssertNil(delete.body)
        XCTAssertEqual(delete.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/analytics-tiles?id=tile-a")
    }

    func testCachedResultMatchesOnSpecAndDay() {
        let spec: JSONValue = ["title": "A"]
        let entry = CachedTileResult(spec: spec, today: "2026-09-12", result: .problem("x"))
        XCTAssertTrue(entry.matches(spec: spec, today: "2026-09-12"))
        XCTAssertFalse(entry.matches(spec: spec, today: "2026-09-13"))
        XCTAssertFalse(entry.matches(spec: ["title": "B"], today: "2026-09-12"))
        XCTAssertFalse(entry.matches(spec: nil, today: "2026-09-12"))
        XCTAssertTrue(AnalyticsRefreshReason.launch.trustsCache)
        XCTAssertTrue(AnalyticsRefreshReason.realtime.trustsCache)
        XCTAssertFalse(AnalyticsRefreshReason.foreground.trustsCache)
        XCTAssertFalse(AnalyticsRefreshReason.afterSave.trustsCache)
        XCTAssertTrue(AnalyticsRefreshReason.pullToRefresh.isUserInitiated)
        XCTAssertFalse(AnalyticsRefreshReason.launch.isUserInitiated)
    }
}
