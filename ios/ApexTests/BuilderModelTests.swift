import ApexCore
import XCTest
import ApexFeatures

/// The builder over the fixtures: the search step, the form rules, Apply's
/// routing into `/api/workout-draft`, and the coach drawer's reduce landing
/// on the form.
final class BuilderModelTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")
    private static func fixture(_ name: String) -> Data { try! Data(contentsOf: fixtures.appendingPathComponent(name)) }
    private static let fixtureNow = Date(timeIntervalSince1970: 1_788_868_800)

    private struct Recorded { let method: String; let path: String; let body: String? }

    private final class Transport: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        /// Answers per route, consumed in order; the last one repeats.
        private var routes: [String: [(Int, Data)]] = [:]
        private(set) var requests: [Recorded] = []

        func set(_ method: String, _ path: String, status: Int = 200, body: Data = Data(#"{"ok":true}"#.utf8)) {
            lock.lock(); routes["\(method) \(path)"] = [(status, body)]; lock.unlock()
        }

        /// Unanswered from now on — the route "has no connection".
        func remove(_ method: String, _ path: String) {
            lock.lock(); routes["\(method) \(path)"] = nil; lock.unlock()
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
            guard let (status, body) = answer else { throw APIError.network("no route for \(key)") }
            return HTTPResponse(status: status, headers: ["Content-Type": key.hasSuffix("chat") ? "application/x-ndjson" : "application/json"], body: body)
        }

        func body(_ method: String, _ path: String) -> String? {
            lock.lock(); defer { lock.unlock() }
            return requests.last { $0.method == method && $0.path == path }?.body
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

    private func transport() -> Transport {
        let t = Transport()
        t.set("GET", "/api/schedule", body: Self.fixture("schedule.json"))
        t.set("GET", "/api/profile", body: Self.fixture("profile.json"))
        t.set("POST", "/api/query", body: Self.fixture("query-get_meals.json"))
        t.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-create.json"))
        t.set("PATCH", "/api/workout-templates", body: Data(#"{"id":"ios-fixture-template"}"#.utf8))
        // The tools-on turn answers with the draft tool; the tools-off follow-up
        // is prose only, as the server's `tool_choice: none` guarantees.
        t.set("POST", "/api/chat", bodies: [
            Self.fixture("chat-stream-builder.ndjson"),
            Data("{\"type\":\"text\",\"delta\":\"Added it. Review the form and press Apply.\"}\n{\"type\":\"done\"}\n".utf8),
        ])
        t.set("POST", "/api/coach-tool", body: Self.fixture("coach-tool-draft.json"))
        return t
    }

    @MainActor
    private func schedule(_ transport: Transport) async -> (ScheduleModel, ApexClient) {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        let model = ScheduleModel(deps: ScheduleDependencies(
            client: client, cache: MemoryCacheStore(), clock: TestClock(now: Self.fixtureNow), streams: nil, realtime: nil,
            timeZone: TimeZone(identifier: "UTC")!, firstWeekday: 2, prefetchesTracker: false
        ))
        await model.start()
        return (model, client)
    }

    @MainActor
    func testSearchFiltersByTitleTagsAndTypeAndBuildsFromTheQuery() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-10")!))
        await builder.start()
        XCTAssertEqual(builder.step, .search)
        XCTAssertEqual(builder.title, "Add Workout")
        XCTAssertEqual(builder.filteredTemplates.map(\.id), ["ios-fixture-template"])
        builder.query = "PUSH"
        XCTAssertEqual(builder.filteredTemplates.count, 1)
        builder.query = "nothing like it"
        XCTAssertEqual(builder.filteredTemplates, [])
        builder.query = ""
        builder.typeFilter = .cardio
        XCTAssertEqual(builder.filteredTemplates, [])
        builder.typeFilter = .weights
        XCTAssertEqual(builder.filteredTemplates.count, 1)

        builder.query = "Leg day"
        builder.startBlank()
        XCTAssertEqual(builder.step, .form)
        XCTAssertEqual(builder.draft.title, "Leg day")
        XCTAssertEqual(builder.draft.date, "2026-09-10")
        XCTAssertEqual(builder.title, "New Workout")
        XCTAssertTrue(builder.isDirty)
    }

    @MainActor
    func testPickingATemplateFillsTheFormOnTheChosenDay() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-10")!))
        await builder.start()
        builder.pick(try XCTUnwrap(builder.templates.first))
        XCTAssertEqual(builder.step, .form)
        XCTAssertEqual(builder.draft.templateId, "ios-fixture-template")
        XCTAssertEqual(builder.draft.title, "Fixture Template Push")
        XCTAssertEqual(builder.draft.date, "2026-09-10")
        XCTAssertEqual(builder.draft.lists.exercises.first?.definitionId, "ios-fixture-def")
        XCTAssertEqual(builder.title, "Fixture Template Push")
        XCTAssertEqual(builder.subtitle, "Thursday, Sep 10")
        XCTAssertFalse(builder.isDirty, "the library already holds this; closing loses nothing")
    }

    @MainActor
    func testSetTypeFollowsTheWebRuleAndEveryEditMarksDirty() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-10")!))
        builder.startBlank()
        XCTAssertEqual(builder.draft.title, "")
        builder.setType(.cardio)
        XCTAssertEqual(builder.draft.title, "Cardio")
        XCTAssertEqual(builder.draft.duration, "45")
        builder.update { $0.title = "Hill repeats" }
        builder.setType(.outdoorClimbing)
        XCTAssertEqual(builder.draft.title, "Hill repeats")
        XCTAssertEqual(builder.draft.sport, "climbing")
        XCTAssertTrue(builder.isDirty)
    }

    @MainActor
    func testApplyCreateSendsTheDraftAndReportsSuccess() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-07")!))
        builder.query = "Fixture Template Push"
        builder.startBlank()
        let closed = await builder.apply()
        XCTAssertTrue(closed)
        let sent = try XCTUnwrap(t.body("POST", "/api/workout-draft"))
        // A new event carries the id it will take (ai-<uuid>), sent on every attempt.
        XCTAssertNotNil(sent.range(of: #"^\{"action":\{"clientId":"ai-[0-9a-f-]{36}","kind":"create"\},"draft":\{"#, options: .regularExpression), sent)
        XCTAssertTrue(sent.contains(#""title":"Fixture Template Push""#))
        XCTAssertFalse(builder.isDirty, "the applied draft is the new baseline")
    }

    @MainActor
    func testApplyRefusesAnInvalidDraftBeforeAnyRequest() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-07")!))
        builder.startBlank()
        // No title — the refusal is a line in the sheet, not a toast under it.
        let applied1 = await builder.apply()
        XCTAssertFalse(applied1)
        XCTAssertEqual(builder.problem, "Give the workout a title")
        // A unilateral count without a side.
        await builder.start()
        builder.update {
            $0.title = "Pistols"
            $0.lists.exercises = [Exercise(id: "p", name: "Pistol", category: "strength", reps: "5", definitionId: "ios-fixture-def")]
        }
        // The fixture definition is not unilateral, so this one passes the local check…
        XCTAssertEqual(builder.errors, [:])
        XCTAssertNil(builder.problem, "the edit cleared it")
        XCTAssertEqual(t.count("POST", "/api/workout-draft"), 0)
        // …and the server's own refusal lands as errors + the line, nothing applied.
        t.set("POST", "/api/workout-draft", body: Data(#"{"ok":false,"problem":"Per-side counts needed for unilateral exercises","violations":{"p":"Per-side count needed"}}"#.utf8))
        let applied2 = await builder.apply()
        XCTAssertFalse(applied2)
        XCTAssertEqual(builder.errors["p"], "Per-side count needed")
        XCTAssertEqual(builder.problem, "Per-side counts needed for unilateral exercises")
        XCTAssertTrue(builder.isDirty)
        // A request that never lands says so in the same place.
        t.set("POST", "/api/workout-draft", status: 500, body: Data("boom".utf8))
        let applied3 = await builder.apply()
        XCTAssertFalse(applied3)
        XCTAssertEqual(builder.problem, "Failed to save — try again")
    }

    @MainActor
    func testEditingASeriesRoutesTheScope() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        t.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-edit.json"))
        let builder = BuilderModel(model: model, route: .edit(eventId: "ios-fixture-weekly__2026-09-15"))
        XCTAssertEqual(builder.step, .form)
        XCTAssertTrue(builder.asksScope)
        XCTAssertEqual(builder.title, "Edit Workout")
        XCTAssertEqual(builder.draft.repeatRule.days, [.tuesday])
        XCTAssertFalse(builder.isDirty)
        builder.update { $0.title = "Fixture Push Day (lighter)" }

        let applied3 = await builder.apply(scope: .series)
        XCTAssertTrue(applied3)
        var sent = try XCTUnwrap(t.body("POST", "/api/workout-draft"))
        XCTAssertTrue(sent.hasPrefix(#"{"action":{"eventId":"ios-fixture-weekly__2026-09-15","kind":"update"}"#), sent)
        XCTAssertTrue(sent.contains(#""repeat":{"days":["TU"],"enabled":true"#))

        t.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-detach.json"))
        let applied4 = await builder.apply(scope: .occurrence)
        XCTAssertTrue(applied4)
        sent = try XCTUnwrap(t.body("POST", "/api/workout-draft"))
        XCTAssertNotNil(sent.range(of: #"^\{"action":\{"clientId":"ai-[0-9a-f-]{36}","eventId":"ios-fixture-weekly__2026-09-15","kind":"detach","occurrenceDate":"2026-09-15"\}"#, options: .regularExpression), sent)
        // A detached day cannot itself repeat: the picker is forced off on the wire.
        XCTAssertTrue(sent.contains(#""repeat":{"days":[],"enabled":false,"interval":"1","until":""}"#), sent)
    }

    @MainActor
    func testEditingAOneOffSavesWithoutAScope() async throws {
        let t = transport()
        let (model, _) = await schedule(t)
        t.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-edit.json"))
        let builder = BuilderModel(model: model, route: .edit(eventId: "ios-fixture-run"))
        XCTAssertFalse(builder.asksScope)
        XCTAssertEqual(builder.draft.startTime, "06:30")
        XCTAssertEqual(builder.draft.sport, "running")
        let applied5 = await builder.apply()
        XCTAssertTrue(applied5)
        XCTAssertTrue(try XCTUnwrap(t.body("POST", "/api/workout-draft")).hasPrefix(#"{"action":{"eventId":"ios-fixture-run","kind":"update"}"#))
    }

    @MainActor
    func testTheCoachsReduceLandsOnTheForm() async throws {
        let t = transport()
        var profile = try JSONSerialization.jsonObject(with: Self.fixture("profile.json")) as! [String: Any]
        profile["hasAnthropicKey"] = true
        t.set("GET", "/api/profile", body: try JSONSerialization.data(withJSONObject: profile))
        let (model, client) = await schedule(t)
        let services = CoachServices(client: client, store: MemoryConversationStore(), clock: TestClock(now: Self.fixtureNow), timeZone: TimeZone(identifier: "UTC")!)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-15")!), coachServices: services)
        builder.startBlank()
        await builder.start()
        let coach = try XCTUnwrap(builder.coach)
        XCTAssertTrue(builder.canCoach)
        XCTAssertEqual(coach.composerPlaceholder, "e.g. \"Make this a 20 min AMRAP of…\"")

        coach.composerText = "add fixture press 3x8"
        await coach.send().value
        // The reduce ran through /api/coach-tool with the form's draft, and the answer replaced the form.
        let reduce = try XCTUnwrap(t.body("POST", "/api/coach-tool"))
        XCTAssertTrue(reduce.contains(#""name":"update_workout_draft""#))
        XCTAssertTrue(reduce.contains(#""draft":{"#))
        XCTAssertEqual(builder.draft.title, "Fixture Coach Draft")
        XCTAssertEqual(builder.draft.lists.exercises.first?.definitionId, "ios-fixture-def")
        XCTAssertEqual(builder.draft.repeatRule.days, [.tuesday])
        XCTAssertEqual(coach.conversations, [], "the builder's thread is never listed")

        // A form edit reaches the session before the next turn.
        builder.update { $0.title = "Renamed by hand" }
        await coach.session.mark(UUID())
        let sessionDraft = await coach.session.config.draft
        XCTAssertEqual(try WorkoutDraft(jsonValue: try XCTUnwrap(sessionDraft)).title, "Renamed by hand")
        builder.shutdown()
    }

    // MARK: - Offline save (D-027 reversed at the user's call)

    /// A backoff that never ends on its own, so an offline queue sits still.
    private struct StalledClock: ApexClock {
        let now: Date
        func sleep(seconds: Double) async throws { try await Task.sleep(for: .seconds(3600)) }
    }

    @MainActor
    private func scheduleWithQueue(_ transport: Transport) async -> (ScheduleModel, WriteQueue) {
        let (model, client) = await schedule(transport)
        let queue = WriteQueue(store: MemoryWriteQueueStore(), client: client, clock: StalledClock(now: Self.fixtureNow))
        model.attach(writeQueue: queue)
        return (model, queue)
    }

    @MainActor
    func testSaveWithNoSignalQueuesTheWorkoutAndClosesTheSheet() async throws {
        let t = transport()
        t.remove("POST", "/api/workout-draft")
        let (model, _) = await scheduleWithQueue(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-10")!))
        await builder.start()
        builder.query = "Leg day"
        builder.startBlank()

        let closed = await builder.apply()
        XCTAssertTrue(closed, "queued, not held open until there is signal")
        XCTAssertNil(builder.problem)
        XCTAssertFalse(builder.isDirty)
        XCTAssertEqual(model.pendingSaves["2026-09-10"], 1)
        model.attach(writeQueue: nil)
    }

    @MainActor
    func testTheQueuedSaveReusesTheIdTheFailedAttemptSent() async throws {
        // The first try may have landed with only its answer lost: the queued
        // replay must name the same event, or the server would write a second.
        let t = transport()
        t.remove("POST", "/api/workout-draft")
        let (model, queue) = await scheduleWithQueue(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-10")!))
        await builder.start()
        builder.query = "Leg day"
        builder.startBlank()
        _ = await builder.apply()

        let firstTry = try XCTUnwrap(t.body("POST", "/api/workout-draft"))
        let ops = await queue.ops(for: .outbox)
        guard case .workoutDraft(let queued) = ops.first?.payload else { return XCTFail("not queued") }
        let id = try XCTUnwrap(queued.clientId)
        XCTAssertTrue(firstTry.contains(#""clientId":"\#(id)""#), firstTry)
        model.attach(writeQueue: nil)
    }

    @MainActor
    func testWithNoQueueSaveWithNoSignalStillSaysSo() async throws {
        let t = transport()
        t.remove("POST", "/api/workout-draft")
        let (model, _) = await schedule(t)
        let builder = BuilderModel(model: model, route: .create(date: DayKey("2026-09-10")!))
        await builder.start()
        builder.query = "Leg day"
        builder.startBlank()
        let closed = await builder.apply()
        XCTAssertFalse(closed)
        XCTAssertEqual(builder.problem, "No connection — couldn't save. Try again when you're back online.")
    }

    @MainActor
    func testFixReopensARefusedSaveWithItsReasonAndASaveRetiresIt() async throws {
        let t = transport()
        t.remove("POST", "/api/workout-draft")
        let (model, queue) = await scheduleWithQueue(t)
        _ = await model.queueDraft(.empty(date: "2026-09-10", title: "Leg day"), action: .create, clientId: "ai-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90")

        // Back online; the server refuses it.
        t.set("POST", "/api/workout-draft", body: Data(#"{"ok":false,"problem":"Add at least one exercise"}"#.utf8))
        await queue.resume()
        let deadline = Date().addingTimeInterval(2)
        while model.refusedSaves.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        let refused = try XCTUnwrap(model.refusedSaves.first)

        let builder = BuilderModel(model: model, route: .fix(saveId: refused.id))
        await builder.start()
        XCTAssertEqual(builder.step, .form)
        XCTAssertEqual(builder.title, "Fix Workout")
        XCTAssertEqual(builder.draft.title, "Leg day")
        XCTAssertEqual(builder.problem, "Add at least one exercise", "the reason is on screen")
        XCTAssertFalse(builder.asksScope)

        // Fixed and saved with signal: it lands, and the refused save goes.
        t.set("POST", "/api/workout-draft", body: Self.fixture("workout-draft-create.json"))
        let closed = await builder.apply()
        XCTAssertTrue(closed)
        XCTAssertTrue(model.refusedSaves.isEmpty)
        XCTAssertTrue((t.body("POST", "/api/workout-draft") ?? "").contains(#""kind":"create""#))
        model.attach(writeQueue: nil)
    }
}
