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
            timeZone: TimeZone(identifier: "UTC")!, firstWeekday: 2,
            // These tests count /api/workout-sessions calls; the tracker prefetch has its own test.
            prefetchesTracker: false
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

    // MARK: - W7 edits

    /// The fixture with one base's fields changed — what the server answers
    /// after a PATCH landed.
    private static func patchedFixture(baseId: String, fields: [String: Any]) -> Data {
        var object = try! JSONSerialization.jsonObject(with: fixture("schedule.json")) as! [String: Any]
        object["bases"] = (object["bases"] as! [[String: Any]]).map { base -> [String: Any] in
            guard base["id"] as? String == baseId else { return base }
            return base.merging(fields) { _, new in new }
        }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    /// The fixture without some stubs (and any base they were the last of).
    private static func withoutStubs(_ ids: Set<String>) -> Data {
        var object = try! JSONSerialization.jsonObject(with: fixture("schedule.json")) as! [String: Any]
        let stubs = (object["occurrences"] as! [[String: Any]]).filter { !ids.contains($0["id"] as! String) }
        let live = Set(stubs.map { $0["baseId"] as! String })
        object["occurrences"] = stubs
        object["bases"] = (object["bases"] as! [[String: Any]]).filter { live.contains($0["id"] as! String) }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func editable() -> ScriptedTransport {
        let t = healthy()
        t.set("PATCH", "/api/events")
        t.set("DELETE", "/api/events")
        t.set("POST", "/api/event-instances")
        t.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-create.json"))
        t.set("PATCH", "/api/workout-templates", body: Data(#"{"id":"ios-fixture-template"}"#.utf8))
        t.set("POST", "/api/exercise-definitions", body: Data(#"{"id":"nordic-curl"}"#.utf8))
        return t
    }

    private func body(_ transport: ScriptedTransport, _ method: String, _ path: String) -> String {
        transport.requests.last { $0.method == method && $0.path == path }?.body ?? ""
    }

    @MainActor
    func testRetitleIsSeriesWideAndPatchesTheBase() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let event = try XCTUnwrap(model.event(id: "ios-fixture-weekly__2026-09-15"))
        transport.set("GET", "/api/schedule", body: Self.patchedFixture(baseId: "ios-fixture-weekly", fields: ["title": "Bench"]))
        let ok = await model.commit(.retitle(event, title: "Bench"))
        XCTAssertTrue(ok)
        XCTAssertEqual(body(transport, "PATCH", "/api/events"), #"{"fields":{"title":"Bench"},"log":{"event_date":"2026-09-15","event_title":"Bench","triggered_by":"user"}}"#)
        // Every occurrence of the series, after the refresh the commit asked for.
        XCTAssertEqual(model.event(id: "ios-fixture-weekly")?.title, "Bench")
        XCTAssertEqual(model.event(id: "ios-fixture-weekly__2026-09-08")?.title, "Bench")
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 2)
    }

    @MainActor
    func testRescheduleOneOffPatchesDateAndTimesAndMovesTheDay() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let run = try XCTUnwrap(model.event(id: "ios-fixture-run"))
        transport.set("GET", "/api/schedule", body: Self.withoutStubs(["ios-fixture-run"]))
        await model.commit(.reschedule(run, OccurrenceOverride(date: "2026-09-09", startTime: "7:00 AM")))
        XCTAssertEqual(body(transport, "PATCH", "/api/events"), #"{"fields":{"date":"2026-09-09","start_time":"7:00 AM"},"log":{"event_date":"2026-09-09","event_title":"Fixture Run","triggered_by":"user"}}"#)
        XCTAssertFalse(model.events(on: day).contains { $0.id == "ios-fixture-run" })
    }

    @MainActor
    func testRescheduleRecurringOccurrenceOverridesKeyedAtTheOriginalDate() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let occurrence = try XCTUnwrap(model.event(id: "ios-fixture-weekly__2026-09-15"))
        await model.commit(.reschedule(occurrence, OccurrenceOverride(startTime: "6:00 AM")))
        XCTAssertEqual(body(transport, "POST", "/api/event-instances"),
                       #"{"date":"2026-09-15","eventId":"ios-fixture-weekly","eventTitle":"Fixture Push Day","overrides":{"date":"2026-09-15","endTime":"18:30","startTime":"6:00 AM"},"triggeredBy":"user"}"#)
        XCTAssertEqual(transport.count("PATCH", "/api/events"), 0)
    }

    @MainActor
    func testDeleteOccurrenceSkipsOneStubAndDeleteSeriesRemovesEveryStub() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let occurrence = try XCTUnwrap(model.event(id: "ios-fixture-weekly__2026-09-08"))
        transport.set("GET", "/api/schedule", body: Self.withoutStubs(["ios-fixture-weekly__2026-09-08"]))
        await model.commit(.skipOccurrence(occurrence))
        XCTAssertEqual(body(transport, "POST", "/api/event-instances"), #"{"date":"2026-09-08","eventId":"ios-fixture-weekly","eventTitle":"Fixture Push Day","triggeredBy":"user"}"#)
        XCTAssertNil(model.event(id: "ios-fixture-weekly__2026-09-08"))
        XCTAssertNotNil(model.event(id: "ios-fixture-weekly__2026-09-15"))

        let series = try XCTUnwrap(model.event(id: "ios-fixture-weekly__2026-09-15"))
        // Every stub the series ever had (the skipped one is already gone from the index).
        let allOfIt = Set(model.index!.response.occurrences.filter { $0.baseId == "ios-fixture-weekly" }.map(\.id)).union(["ios-fixture-weekly__2026-09-08"])
        transport.set("GET", "/api/schedule", body: Self.withoutStubs(allOfIt))
        await model.commit(.deleteEvent(series))
        XCTAssertEqual(body(transport, "DELETE", "/api/events"), #"{"log":{"event_date":"2026-09-15","event_title":"Fixture Push Day","triggered_by":"user"}}"#)
        XCTAssertNil(model.event(id: "ios-fixture-weekly"))
        XCTAssertEqual(model.events(on: day).count, 3)
    }

    @MainActor
    func testEditFailureRollsBackAndSkipsTheRefresh() async throws {
        let transport = editable()
        transport.set("PATCH", "/api/events", status: 500, body: Data("boom".utf8))
        let model = makeModel(transport)
        await model.start()
        let run = try XCTUnwrap(model.event(id: "ios-fixture-run"))
        let ok = await model.commit(.retitle(run, title: "Nope"))
        XCTAssertFalse(ok)
        XCTAssertEqual(model.event(id: "ios-fixture-run")?.title, "Fixture Run")
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 1)
    }

    @MainActor
    func testEditSectionsPatchesOnlyTheChangedSections() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let circuit = try XCTUnwrap(model.event(id: "ios-fixture-circuit"))
        await model.commit(.setSections(circuit, warmup: [], exercises: nil, cooldown: nil))
        let sent = body(transport, "PATCH", "/api/events")
        XCTAssertTrue(sent.hasPrefix(#"{"fields":{"warmup":[]},"log":"#), sent)
        XCTAssertFalse(sent.contains("exercises"))
    }

    @MainActor
    func testApplyDraftCreateInsertsTheReturnedEventAndRefreshes() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let response = await model.applyDraft(.empty(date: "2026-09-07", title: "Fixture Template Push"), action: .create)
        XCTAssertEqual(response?.ok, true)
        XCTAssertEqual(response?.templateId, "ios-fixture-template")
        // Before the refresh's answer arrives the created event is already on its day…
        // …and after it (the fixture does not carry it) the refresh count shows it was asked for.
        XCTAssertEqual(transport.count("POST", "/api/workout-draft"), 1)
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 2)
        let sent = body(transport, "POST", "/api/workout-draft")
        XCTAssertTrue(sent.hasPrefix(#"{"action":{"kind":"create"},"draft":{"#), sent)
        XCTAssertTrue(sent.hasSuffix(#""today":"2026-09-08"}"#), sent)
    }

    @MainActor
    func testApplyDraftProblemLeavesTheIndexAloneAndSkipsTheRefresh() async throws {
        let transport = editable()
        transport.set("POST", "/api/workout-draft", body: Data(#"{"ok":false,"problem":"Give the workout a title"}"#.utf8))
        let model = makeModel(transport)
        await model.start()
        let before = model.index
        let response = await model.applyDraft(.empty(date: "2026-09-07"), action: .create)
        XCTAssertEqual(response?.ok, false)
        XCTAssertEqual(response?.problem, "Give the workout a title")
        XCTAssertEqual(model.index, before)
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 1)
    }

    @MainActor
    func testApplyDraftTransportFailureIsNil() async throws {
        let transport = editable()
        transport.set("POST", "/api/workout-draft", status: 500, body: Data("boom".utf8))
        let model = makeModel(transport)
        await model.start()
        let response = await model.applyDraft(.empty(date: "2026-09-07", title: "x"), action: .create)
        XCTAssertNil(response)
        XCTAssertEqual(transport.count("GET", "/api/schedule"), 1)
    }

    @MainActor
    func testApplyDraftDetachSendsTheKeyDateAndSwapsTheOccurrence() async throws {
        let transport = editable()
        transport.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-detach.json"))
        let model = makeModel(transport)
        await model.start()
        let occurrence = try XCTUnwrap(model.event(id: "ios-fixture-weekly__2026-09-29"))
        transport.set("GET", "/api/schedule", body: Self.withoutStubs(["ios-fixture-weekly__2026-09-29"]))
        let response = await model.applyDraft(WorkoutDraft(event: occurrence), action: .detach(eventId: occurrence.id, occurrenceDate: occurrence.keyDate))
        XCTAssertEqual(response?.action, "detach")
        XCTAssertTrue(body(transport, "POST", "/api/workout-draft").hasPrefix(#"{"action":{"eventId":"ios-fixture-weekly__2026-09-29","kind":"detach","occurrenceDate":"2026-09-29"}"#))
        XCTAssertNil(model.event(id: "ios-fixture-weekly__2026-09-29"))
    }

    @MainActor
    func testTemplatesReadFromTheCacheAndArchiveFollows() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        let templates = await model.templates()
        XCTAssertEqual(templates.map(\.id), ["ios-fixture-template"])
        XCTAssertNil(templates.first?.archivedAt)
        let ok = await model.archiveTemplate(id: "ios-fixture-template", archived: true)
        XCTAssertTrue(ok)
        XCTAssertEqual(body(transport, "PATCH", "/api/workout-templates"), #"{"archived_at":"2026-09-08T12:00:00.000Z"}"#)
        let after = await model.templates()
        XCTAssertNotNil(after.first?.archivedAt)
    }

    @MainActor
    func testCreateDefinitionMintsTheSlugAndLandsInTheCache() async throws {
        let transport = editable()
        let model = makeModel(transport)
        await model.start()
        // The name is trimmed, not otherwise rewritten (the web sends `query.trim()`); the id is the slug.
        let created = await model.createDefinition(name: " Nordic Curl ", category: "strength", isUnilateral: false)
        XCTAssertEqual(created?.id, "nordic-curl")
        XCTAssertEqual(created?.canonicalName, "Nordic Curl")
        XCTAssertEqual(body(transport, "POST", "/api/exercise-definitions"),
                       #"{"aliases":[],"canonical_name":"Nordic Curl","category":"strength","equipment":[],"id":"nordic-curl","is_unilateral":false,"muscle_groups":[],"triggered_by":"user"}"#)
        let definitions = await model.definitions()
        XCTAssertTrue(definitions.contains { $0.id == "nordic-curl" })
        XCTAssertTrue(definitions.contains { $0.id == "ios-fixture-def" })
    }
}
