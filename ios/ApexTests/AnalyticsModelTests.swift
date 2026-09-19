import ApexCore
import XCTest
import ApexFeatures

/// The Analytics model against a scripted transport and an in-memory cache:
/// cache-first render, one compute per refresh with cache hits honoured only
/// on launch and realtime, the edit mode's commit and rollback, duplicate
/// and delete with rollback, chunking past 24 tiles.
final class AnalyticsModelTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ApexTests
        .deletingLastPathComponent()  // ios
        .appendingPathComponent("Fixtures")

    private static func fixture(_ name: String) -> Data {
        try! Data(contentsOf: fixtures.appendingPathComponent(name))
    }

    /// 2026-09-08T12:00:00Z — the mock clock; the fixtures were computed for
    /// 2026-09-22, so a cache entry from the fixture never matches "today"
    /// unless a test writes one for the model's own day.
    private static let fixtureNow = Date(timeIntervalSince1970: 1_788_868_800)

    private struct Recorded: Equatable { let method: String; let path: String; let body: String? }

    /// Answers per route, consumed in order; the last one repeats.
    private final class Transport: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var routes: [String: [(Int, Data)]] = [:]
        private(set) var requests: [Recorded] = []

        func set(_ method: String, _ path: String, status: Int = 200, body: Data = Data(#"{"ok":true}"#.utf8)) {
            lock.lock(); routes["\(method) \(path)"] = [(status, body)]; lock.unlock()
        }

        func set(_ method: String, _ path: String, bodies: [Data]) {
            lock.lock(); routes["\(method) \(path)"] = bodies.map { (200, $0) }; lock.unlock()
        }

        func failAll(status: Int = 503) {
            lock.lock()
            for key in routes.keys { routes[key] = [(status, Data("down".utf8))] }
            lock.unlock()
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
            guard let (status, body) = answer else { throw APIError.network("no route for \(key)") }
            return HTTPResponse(status: status, headers: ["Content-Type": "application/json"], body: body)
        }

        func count(_ method: String, _ path: String) -> Int {
            lock.lock(); defer { lock.unlock() }
            return requests.filter { $0.method == method && $0.path == path }.count
        }

        func body(_ method: String, _ path: String) -> String? {
            lock.lock(); defer { lock.unlock() }
            return requests.last { $0.method == method && $0.path == path }?.body
        }

        func bodies(_ method: String, _ path: String) -> [String] {
            lock.lock(); defer { lock.unlock() }
            return requests.filter { $0.method == method && $0.path == path }.compactMap(\.body)
        }
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    private func healthy() -> Transport {
        let t = Transport()
        t.set("GET", "/api/analytics-tiles", body: Self.fixture("analytics-tiles.json"))
        t.set("POST", "/api/analytics-compute", body: Self.fixture("analytics-compute.json"))
        t.set("PATCH", "/api/analytics-tiles")
        t.set("DELETE", "/api/analytics-tiles", body: Data(#"{"id":"x"}"#.utf8))
        t.set("POST", "/api/analytics-tiles", body: Self.fixture("analytics-tiles-save.json"))
        return t
    }

    @MainActor
    private func makeModel(_ transport: Transport, cache: MemoryCacheStore = MemoryCacheStore(), clock: TestClock = TestClock(now: fixtureNow)) -> AnalyticsModel {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        return AnalyticsModel(deps: AnalyticsDependencies(client: client, cache: cache, clock: clock, realtime: nil, timeZone: TimeZone(identifier: "UTC")!))
    }

    private var tileIds: [String] { ["sessions", "tonnage", "time", "grade", "hr", "distance"].map { "ios-fixture-tile-\($0)" } }

    // MARK: - Loading

    @MainActor
    func testStartReadsTilesThenComputesEverythingInOneRequest() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        XCTAssertEqual(model.tiles.map(\.id), tileIds)
        XCTAssertTrue(model.hasLoaded)
        XCTAssertEqual(transport.count("GET", "/api/analytics-tiles"), 1)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1)
        // Six specs, in tiles order, with the model's own today.
        let body = try XCTUnwrap(transport.body("POST", "/api/analytics-compute"))
        XCTAssertTrue(body.contains(#""today":"2026-09-08""#), body)
        XCTAssertEqual(body.components(separatedBy: "\"version\":1").count - 1, 6)
        // Results land by tile id, index-aligned.
        XCTAssertEqual(model.results.count, 6)
        guard case .ok(let sessions) = model.results["ios-fixture-tile-sessions"] else { return XCTFail("the KPI should have a result") }
        XCTAssertEqual(sessions.series.first?.points, [1])
        guard case .ok(let grade) = model.results["ios-fixture-tile-grade"] else { return XCTFail("the grade tile should have a result") }
        XCTAssertEqual(grade.series.first?.gradeLabels?.compactMap { $0 }, ["5.10c"])
        XCTAssertNil(model.freshnessLabel)
    }

    @MainActor
    func testTheCacheRendersFirstAndAMatchingResultSkipsCompute() async throws {
        let transport = healthy()
        let cache = MemoryCacheStore()
        let first = makeModel(transport, cache: cache)
        await first.start()
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1)

        // A second model over the same cache: tiles show before any request,
        // and launch trusts every result computed today for an unchanged spec.
        let second = makeModel(transport, cache: cache)
        transport.failAll()
        await second.start()
        XCTAssertEqual(second.tiles.map(\.id), tileIds)
        XCTAssertEqual(second.results.count, 6)
        XCTAssertNil(second.loadError)
        XCTAssertTrue(second.lastRefreshFailed)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1)
    }

    @MainActor
    func testLaunchTrustsTheCacheButForegroundRecomputes() async throws {
        let transport = healthy()
        let cache = MemoryCacheStore()
        let model = makeModel(transport, cache: cache)
        await model.start()
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1)
        await model.refresh(reason: .realtime)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1, "realtime on tiles says nothing about the logs; matching results stand")
        await model.refresh(reason: .foreground)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 2)
        await model.refresh(reason: .pullToRefresh)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 3)
    }

    @MainActor
    func testACachedResultFromAnotherDayIsNotShown() async throws {
        let transport = healthy()
        let cache = MemoryCacheStore()
        let yesterday = makeModel(transport, cache: cache, clock: TestClock(now: Self.fixtureNow.addingTimeInterval(-86_400)))
        await yesterday.start()
        let today = makeModel(transport, cache: cache)
        transport.failAll()
        await today.start()
        XCTAssertEqual(today.tiles.count, 6, "the tiles list itself is day-agnostic")
        XCTAssertEqual(today.results.count, 0, "yesterday's numbers are not today's")
    }

    @MainActor
    func testAnInvalidTileNeverHitsCompute() async throws {
        let transport = healthy()
        var response = try JSONDecoder().decode(AnalyticsTilesResponse.self, from: Self.fixture("analytics-tiles.json"))
        var broken = response.tiles[0]
        broken.spec = nil
        broken.draft = nil
        response = AnalyticsTilesResponse(tiles: [broken], options: response.options)
        transport.set("GET", "/api/analytics-tiles", body: try JSONEncoder().encode(response))
        let model = makeModel(transport)
        await model.start()
        XCTAssertEqual(model.tiles.count, 1)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 0)
        XCTAssertNil(model.result(for: model.tiles[0]))
    }

    @MainActor
    func testNothingCachedAndNoNetworkIsAnErrorRetryClears() async throws {
        let transport = healthy()
        transport.failAll()
        let model = makeModel(transport)
        await model.start()
        XCTAssertTrue(model.tiles.isEmpty)
        XCTAssertNotNil(model.loadError)
        transport.set("GET", "/api/analytics-tiles", body: Self.fixture("analytics-tiles.json"))
        transport.set("POST", "/api/analytics-compute", body: Self.fixture("analytics-compute.json"))
        await model.refresh(reason: .retry)
        XCTAssertNil(model.loadError)
        XCTAssertEqual(model.tiles.count, 6)
    }

    @MainActor
    func testRefreshCoalescesAConcurrentRequestIntoOneMore() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        async let a: Void = model.refresh(reason: .foreground)
        async let b: Void = model.refresh(reason: .foreground)
        async let c: Void = model.refresh(reason: .foreground)
        _ = await (a, b, c)
        XCTAssertEqual(transport.count("GET", "/api/analytics-tiles"), 3, "one in flight, one queued after it — never three at once")
    }

    @MainActor
    func testTwentyFiveTilesComputeInTwoRequests() async throws {
        let transport = healthy()
        let base = try JSONDecoder().decode(AnalyticsTilesResponse.self, from: Self.fixture("analytics-tiles.json"))
        let many = (0..<25).map { i in
            AnalyticsTile(id: "tile-\(i)", title: "T\(i)", spec: base.tiles[0].spec, draft: base.tiles[0].draft, layout: TileLayout(x: 0, y: i * 2, w: 12, h: 2))
        }
        transport.set("GET", "/api/analytics-tiles", body: try JSONEncoder().encode(AnalyticsTilesResponse(tiles: many, options: .empty)))
        let slot = try JSONDecoder().decode(AnalyticsComputeResponse.self, from: Self.fixture("analytics-compute.json")).tiles[0]
        let twentyFour = try JSONEncoder().encode(AnalyticsComputeResponse(today: "2026-09-08", tiles: Array(repeating: slot, count: 24)))
        let one = try JSONEncoder().encode(AnalyticsComputeResponse(today: "2026-09-08", tiles: [slot]))
        transport.set("POST", "/api/analytics-compute", bodies: [twentyFour, one])
        let model = makeModel(transport)
        await model.start()
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 2)
        XCTAssertEqual(model.results.count, 25)
    }

    // MARK: - Edit mode

    @MainActor
    func testCommitWritesOnlyTheChangedRowsAsFullWidthCumulativeRows() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        model.beginEdit()
        XCTAssertTrue(model.isEditing)
        XCTAssertEqual(model.editHeights["ios-fixture-tile-sessions"], .medium)
        // Move the KPI to the bottom and make the tonnage bars tall.
        model.move(from: IndexSet(integer: 0), to: 6)
        model.setHeight("ios-fixture-tile-tonnage", .large)
        let ok = await model.commitEdit()
        XCTAssertTrue(ok)
        XCTAssertFalse(model.isEditing)
        // Every row moved (the y values shifted) or changed width — the fixture is w 6.
        let body = try XCTUnwrap(transport.body("PATCH", "/api/analytics-tiles"))
        XCTAssertTrue(body.hasPrefix(#"{"layouts":[{"h":6,"id":"ios-fixture-tile-tonnage","w":12,"x":0,"y":0}"#), body)
        XCTAssertTrue(body.contains(#"{"h":4,"id":"ios-fixture-tile-sessions","w":12,"x":0,"y":22}"#), body)
        XCTAssertEqual(model.tiles.map(\.id).first, "ios-fixture-tile-tonnage")
        XCTAssertEqual(model.tiles.map(\.id).last, "ios-fixture-tile-sessions")
        XCTAssertEqual(model.tiles.first?.layout, TileLayout(x: 0, y: 0, w: 12, h: 6))
        // Nothing to compute again: the specs did not change.
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1)
    }

    @MainActor
    func testCommitWithNoChangeWritesNothingAndCancelReverts() async throws {
        let transport = healthy()
        // Fixture tiles are w 6, so first commit a full-width layout, then re-enter.
        let model = makeModel(transport)
        await model.start()
        model.beginEdit()
        await model.commitEdit()
        XCTAssertEqual(transport.count("PATCH", "/api/analytics-tiles"), 1)
        model.beginEdit()
        await model.commitEdit()
        XCTAssertEqual(transport.count("PATCH", "/api/analytics-tiles"), 1, "an unchanged layout is not a write")
        model.beginEdit()
        model.move(from: IndexSet(integer: 0), to: 6)
        model.cancelEdit()
        XCTAssertFalse(model.isEditing)
        XCTAssertEqual(model.tiles.map(\.id), tileIds)
        XCTAssertEqual(transport.count("PATCH", "/api/analytics-tiles"), 1)
    }

    @MainActor
    func testAFailedCommitRestoresTheOrderAndHeights() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        let before = model.tiles
        transport.set("PATCH", "/api/analytics-tiles", status: 500, body: Data("down".utf8))
        model.beginEdit()
        model.move(from: IndexSet(integer: 0), to: 6)
        model.setHeight("ios-fixture-tile-tonnage", .small)
        let ok = await model.commitEdit()
        XCTAssertFalse(ok)
        XCTAssertEqual(model.tiles, before)
    }

    // MARK: - Kebab

    @MainActor
    func testDuplicatePostsACopyBelowTheDashboardAndReusesTheResult() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        let source = model.tiles[1]   // tonnage, h 4
        await model.duplicate(source)
        XCTAssertEqual(model.tiles.count, 7)
        let body = try XCTUnwrap(transport.body("POST", "/api/analytics-tiles"))
        XCTAssertTrue(body.contains(#""title":"Tonnage (copy)""#), body)
        XCTAssertTrue(body.contains(#""layout":{"h":4,"w":12,"x":0,"y":24}"#), body)
        XCTAssertTrue(body.contains(#""id":"tile-"#), body)
        // The server's answer replaced the optimistic copy; the numbers were reused, not recomputed.
        XCTAssertEqual(model.tiles.last?.id, "ios-fixture-tile-save")
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 1)
    }

    @MainActor
    func testDuplicateRollsBackWhenTheSaveFails() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        transport.set("POST", "/api/analytics-tiles", status: 500, body: Data("down".utf8))
        await model.duplicate(model.tiles[0])
        XCTAssertEqual(model.tiles.map(\.id), tileIds)
        XCTAssertEqual(model.results.count, 6)
    }

    @MainActor
    func testDeleteIsOptimisticRollsBackOn500AndStandsOn404() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        let gone = model.tiles[2]
        await model.delete(gone)
        XCTAssertEqual(model.tiles.count, 5)
        XCTAssertNil(model.results[gone.id])
        XCTAssertTrue(transport.requests.contains { $0.method == "DELETE" && $0.path == "/api/analytics-tiles" })

        transport.set("DELETE", "/api/analytics-tiles", status: 500, body: Data("down".utf8))
        let kept = model.tiles[0]
        await model.delete(kept)
        XCTAssertEqual(model.tiles.count, 5, "a failed delete comes back")
        XCTAssertNotNil(model.results[kept.id])

        transport.set("DELETE", "/api/analytics-tiles", status: 404, body: Data("Tile not found".utf8))
        await model.delete(model.tiles[0])
        XCTAssertEqual(model.tiles.count, 4, "already gone elsewhere stays gone")
    }

    @MainActor
    func testSavedFromTheBuilderShowsTheTileAndRefreshes() async throws {
        let transport = healthy()
        let model = makeModel(transport)
        await model.start()
        let saved = try JSONDecoder().decode(TileSaveResponse.self, from: Self.fixture("analytics-tiles-save.json"))
        let tile = try XCTUnwrap(saved.tile)
        // The server lists the new tile from now on.
        var listed = try JSONDecoder().decode(AnalyticsTilesResponse.self, from: Self.fixture("analytics-tiles.json"))
        listed = AnalyticsTilesResponse(tiles: listed.tiles + [tile], options: listed.options)
        transport.set("GET", "/api/analytics-tiles", body: try JSONEncoder().encode(listed))
        await model.saved(tile, result: .problem("preview"))
        XCTAssertTrue(model.tiles.contains { $0.id == tile.id })
        XCTAssertEqual(model.tiles.count, 7)
        XCTAssertEqual(transport.count("GET", "/api/analytics-tiles"), 2)
        // The refresh recomputed everything (afterSave does not trust the cache).
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 2)
    }

    @MainActor
    func testTheEmptyDashboardIsOnlyEmptyOnceSomethingAnswered() async throws {
        let transport = healthy()
        transport.set("GET", "/api/analytics-tiles", body: Data(#"{"tiles":[],"options":{"categories":[],"otherWorkoutTitles":[]}}"#.utf8))
        let model = makeModel(transport)
        XCTAssertFalse(model.hasLoaded)
        await model.start()
        XCTAssertTrue(model.hasLoaded)
        XCTAssertTrue(model.tiles.isEmpty)
        XCTAssertEqual(transport.count("POST", "/api/analytics-compute"), 0)
    }

    /// A Swift Chart says nothing to VoiceOver on its own. The summary is what
    /// the tile reads as, and what the chart rotor opens with.
    func testChartAccessibilitySummaryNamesTheShapeOfTheData() {
        let data = TileData(
            buckets: [.init(key: "2026-07", label: "Jul"), .init(key: "2026-08", label: "Aug"), .init(key: "2026-09", label: "Sep")],
            series: [
                TileData.Series(key: "s1", label: "Tonnage", unitKind: "weight", unit: "lb", axis: "left", points: [1000, nil, 4500]),
            ],
            rangeLabel: "Jul–Sep"
        )
        XCTAssertEqual(
            TileChartDescriptor(kind: .line, data: data).summary,
            "Line chart. Jul–Sep. Tonnage: 1,000 lb to 4,500 lb across 2 points."
        )

        // A grade series reads as grades, never as the ranks behind them.
        let grades = TileData(
            buckets: [.init(key: "2026-08", label: "Aug"), .init(key: "2026-09", label: "Sep")],
            series: [
                TileData.Series(key: "g", label: "Hardest send", unitKind: "grade", unit: nil, axis: "left", points: [3, 7], gradeLabels: ["5.10a", "5.12c"]),
            ]
        )
        XCTAssertEqual(
            TileChartDescriptor(kind: .bar, data: grades).summary,
            "Bar chart. Hardest send: 5.10a to 5.12c across 2 points."
        )

        // Nothing plotted still says something.
        let empty = TileData(buckets: [], series: [])
        XCTAssertEqual(TileChartDescriptor(kind: .stackedBar, data: empty).summary, "Stacked bar chart. No series plotted.")
    }
}
