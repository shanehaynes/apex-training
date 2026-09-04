import ApexCore
import XCTest
import ApexFeatures

/// The Schedule model against a scripted transport and an in-memory cache:
/// stale-while-revalidate, the optimistic toggle and its two failure modes,
/// refresh coalescing, meals per month.
final class ScheduleModelTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ApexTests
        .deletingLastPathComponent()  // ios
        .appendingPathComponent("Fixtures")

    private static func fixture(_ name: String) -> Data {
        try! Data(contentsOf: fixtures.appendingPathComponent(name))
    }

    /// 2026-09-08T12:00:00Z.
    private static let fixtureNow = Date(timeIntervalSince1970: 1_788_868_800)

    private struct Recorded: Equatable { let method: String; let path: String; let body: String? }

    /// Answers by route; every answer can be swapped mid-test.
    private final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var routes: [String: (Int, Data)] = [:]
        private(set) var requests: [Recorded] = []
        var delay: Duration = .zero

        func set(_ method: String, _ path: String, status: Int = 200, body: Data = Data(#"{"ok":true}"#.utf8)) {
            lock.lock(); routes["\(method) \(path)"] = (status, body); lock.unlock()
        }

        func failAll(status: Int = 503) {
            lock.lock()
            for key in routes.keys { routes[key] = (status, Data("down".utf8)) }
            lock.unlock()
        }

        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            let recorded = Recorded(method: request.httpMethod ?? "GET", path: request.url?.path ?? "",
                                    body: request.httpBody.map { String(decoding: $0, as: UTF8.self) })
            let answer: (Int, Data)? = lock.withLock {
                requests.append(recorded)
                return routes[key]
            }
            if delay > .zero { try await Task.sleep(for: delay) }
            guard let (status, body) = answer else { throw APIError.network("no route for \(key)") }
            return HTTPResponse(status: status, headers: [:], body: body)
        }

        func count(_ method: String, _ path: String) -> Int {
            lock.lock(); defer { lock.unlock() }
            return requests.filter { $0.method == method && $0.path == path }.count
        }
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    private func healthy() -> ScriptedTransport {
        let t = ScriptedTransport()
        t.set("GET", "/api/schedule", body: Self.fixture("schedule.json"))
        t.set("GET", "/api/profile", body: Self.fixture("profile.json"))
        t.set("POST", "/api/query", body: Self.fixture("query-get_meals.json"))
        t.set("POST", "/api/completions")
        t.set("POST", "/api/workout-sessions")
        return t
    }

    @MainActor
    private func makeModel(_ transport: ScriptedTransport, cache: MemoryCacheStore = MemoryCacheStore(), clock: TestClock = TestClock(now: fixtureNow)) -> ScheduleModel {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        return ScheduleModel(deps: ScheduleDependencies(
            client: client, cache: cache, clock: clock, streams: nil, realtime: nil,
            timeZone: TimeZone(identifier: "UTC")!, firstWeekday: 2
        ))
    }

    private let day = DayKey("2026-09-08")!

    /// schedule.json with one stub flipped to completed — what the server
    /// answers after a successful completion write.
    private static func flippedFixture(id: String, completedAt: String) -> Data {
        var object = try! JSONSerialization.jsonObject(with: fixture("schedule.json")) as! [String: Any]
        object["occurrences"] = (object["occurrences"] as! [[String: Any]]).map { stub -> [String: Any] in
            guard stub["id"] as? String == id else { return stub }
            var flipped = stub
            flipped["isCompleted"] = true
            flipped["completedAt"] = completedAt
            return flipped
        }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    @MainActor
    func testNetworkFillsTheIndexAndTheCache() async throws {
        let cache = MemoryCacheStore()
        let model = makeModel(healthy(), cache: cache)
        await model.start()
        XCTAssertEqual(model.events(on: day).count, 4)
        XCTAssertEqual(model.events(on: day).map(\.title).first, "Fixture Run")
        XCTAssertFalse(model.lastRefreshFailed)
        XCTAssertNil(model.freshnessLabel)
        let window = try await cache.read(kind: .scheduleWindow, key: ScheduleCacheKey.window)
        let definitions = try await cache.read(kind: .definitions, key: ScheduleCacheKey.definitions)
        XCTAssertNotNil(window)
        XCTAssertNotNil(definitions)
        XCTAssertEqual(model.today, day)
        XCTAssertEqual(model.periodTitle, "Tue, Sep 8")
    }

    @MainActor
    func testCacheRendersWhenTheNetworkIsDown() async throws {
        let cache = MemoryCacheStore()
        try await cache.write(CacheEntry(kind: .scheduleWindow, key: ScheduleCacheKey.window,
                                         json: Self.fixture("schedule.json"), fetchedAt: Self.fixtureNow.addingTimeInterval(-10 * 60)))
        let transport = healthy()
        transport.failAll()
        let model = makeModel(transport, cache: cache)
        await model.start()
        XCTAssertEqual(model.events(on: day).count, 4, "the cache rendered")
        XCTAssertTrue(model.lastRefreshFailed)
        XCTAssertNil(model.loadError, "an error banner would hide a perfectly good cache")
        XCTAssertNil(model.freshnessLabel, "ten minutes old is not stale")
    }

    @MainActor
    func testStaleBannerNeedsAgeAndAFailure() async throws {
        let cache = MemoryCacheStore()
        try await cache.write(CacheEntry(kind: .scheduleWindow, key: ScheduleCacheKey.window,
                                         json: Self.fixture("schedule.json"), fetchedAt: Self.fixtureNow.addingTimeInterval(-3 * 3600 - 1)))
        let transport = healthy()
        transport.failAll()
        let model = makeModel(transport, cache: cache)
        await model.start()
        XCTAssertEqual(model.freshnessLabel, "cached · updated 3h ago")

        // The next successful refresh clears it.
        transport.set("GET", "/api/schedule", body: Self.fixture("schedule.json"))
        await model.refresh(reason: .foreground)
        XCTAssertNil(model.freshnessLabel)
    }

    @MainActor
    func testNoCacheAndNoNetworkIsAnError() async {
        let transport = healthy()
        transport.failAll()
        let model = makeModel(transport)
        await model.start()
        XCTAssertNil(model.index)
        XCTAssertNotNil(model.loadError)
    }

    @MainActor
    func testHorizonLabelPastTheWindow() async {
        let model = makeModel(healthy())
        await model.start()
        model.select(DayKey("2026-10-01")!)  // the fixture window ends 2026-09-30
        XCTAssertEqual(model.freshnessLabel, "schedule cached through Sep 30")
    }

    @MainActor
    func testToggleSendsBothWritesAndPersists() async throws {
        let cache = MemoryCacheStore()
        let transport = healthy()
        let model = makeModel(transport, cache: cache)
        await model.start()
        let run = try XCTUnwrap(model.event(id: "ios-fixture-run"))
        XCTAssertFalse(run.isCompleted)

        // The refresh after the writes re-reads the window; a real server now
        // says completed, so the scripted one must too — otherwise the test
        // would only prove that server truth wins, which it should.
        transport.set("GET", "/api/schedule", body: Self.flippedFixture(id: "ios-fixture-run", completedAt: "2026-09-08T12:00:00.000Z"))
        await model.toggleCompletion(run)
        XCTAssertTrue(model.event(id: "ios-fixture-run")!.isCompleted)
        XCTAssertEqual(model.event(id: "ios-fixture-run")!.completedAt, "2026-09-08T12:00:00.000Z")

        let completion = try XCTUnwrap(transport.requests.first { $0.path == "/api/completions" })
        XCTAssertTrue(completion.body!.contains(#""event_id":"ios-fixture-run""#))
        XCTAssertTrue(completion.body!.contains(#""action":"complete""#))
        let quick = try XCTUnwrap(transport.requests.first { $0.path == "/api/workout-sessions" })
        XCTAssertEqual(quick.body, #"{"action":"quick-complete","eventDate":"2026-09-08","eventId":"ios-fixture-run"}"#)

        // The cache carries the flip, so an offline relaunch shows it.
        let stored = try await cache.read(kind: .scheduleWindow, key: ScheduleCacheKey.window)
        let entry = try XCTUnwrap(stored)
        let cached = ScheduleIndex(try JSONDecoder().decode(ScheduleResponse.self, from: entry.json))
        XCTAssertTrue(cached.event(id: "ios-fixture-run")!.isCompleted)
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 2, "launch, then the re-read after the writes")
    }

    @MainActor
    func testToggleRollsBackWhenTheCompletionWriteFails() async throws {
        let transport = healthy()
        transport.set("POST", "/api/completions", status: 503, body: Data("down".utf8))
        let model = makeModel(transport)
        await model.start()
        let run = try XCTUnwrap(model.event(id: "ios-fixture-run"))
        await model.toggleCompletion(run)
        XCTAssertFalse(model.event(id: "ios-fixture-run")!.isCompleted, "rolled back")
        XCTAssertEqual(transport.count("POST", "/api/workout-sessions"), 0, "never reached the plan-fill")
    }

    @MainActor
    func testToggleKeepsTheStateWhenOnlyThePlanFillFails() async throws {
        let transport = healthy()
        transport.set("POST", "/api/workout-sessions", status: 500, body: Data("down".utf8))
        let model = makeModel(transport)
        await model.start()
        let done = try XCTUnwrap(model.event(id: "ios-fixture-weekly__2026-09-08"))
        XCTAssertTrue(done.isCompleted)
        await model.toggleCompletion(done)
        // The refresh afterwards re-reads the fixture, which says completed; the
        // point is that no rollback happened between the two writes.
        XCTAssertEqual(transport.count("POST", "/api/completions"), 1)
        XCTAssertEqual(transport.count("POST", "/api/workout-sessions"), 1)
        XCTAssertTrue(transport.requests.last { $0.path == "/api/workout-sessions" }!.body!.contains("quick-uncomplete"))
    }

    @MainActor
    func testConcurrentRefreshesCoalesce() async {
        let transport = healthy()
        transport.delay = .milliseconds(80)
        let model = makeModel(transport)
        async let a: Void = model.refresh(reason: .foreground)
        async let b: Void = model.refresh(reason: .realtime)
        async let c: Void = model.refresh(reason: .realtime)
        _ = await (a, b, c)
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 2, "one in flight, one pending — never three")
    }

    @MainActor
    func testMealsAreCachedPerMonth() async throws {
        let cache = MemoryCacheStore()
        let transport = healthy()
        let model = makeModel(transport, cache: cache)
        await model.start()
        let meals = try XCTUnwrap(model.meals(on: day))
        XCTAssertEqual(meals.mealCount, 2)
        XCTAssertEqual(meals.totals.calories, 1114)
        let mealsEntry = try await cache.read(kind: .mealsWindow, key: "2026-09")
        XCTAssertNotNil(mealsEntry)
        let calls = transport.count("POST", "/api/query")
        await model.loadMeals(for: DayKey("2026-09-20")!)
        XCTAssertEqual(transport.count("POST", "/api/query"), calls, "same month, no second call")
    }

    @MainActor
    func testStepAndToday() async {
        let model = makeModel(healthy())
        await model.start()
        model.step(1)
        XCTAssertEqual(model.selectedDay.string, "2026-09-09")
        XCTAssertFalse(model.isShowingToday)
        model.mode = .month
        model.step(1)
        XCTAssertEqual(model.selectedDay.string, "2026-10-09")
        XCTAssertEqual(model.periodTitle, "October 2026")
        model.goToToday()
        XCTAssertTrue(model.isShowingToday)
        XCTAssertEqual(model.selectedDay, model.today)
    }
}
