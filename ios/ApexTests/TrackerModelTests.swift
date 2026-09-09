import ApexActivity
import ApexCore
import XCTest
import ApexFeatures

/// The tracker model over a scripted transport, an in-memory cache, an
/// in-memory write queue and a test clock: the open paths, the debounce, the
/// finish gate, offline finish, cancel, swap, reopen, the summary states.
final class TrackerModelTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    private static func fixture(_ name: String) -> Data {
        try! Data(contentsOf: fixtures.appendingPathComponent(name))
    }

    /// 2026-09-22T12:00:00Z — the tracked occurrence's day.
    private static let now = Date(timeIntervalSince1970: 1_790_078_400)

    private struct Recorded: Equatable { let method: String; let path: String; let body: String? }

    /// Answers by `METHOD /path[ action]`; every answer can be swapped mid-test.
    private final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var routes: [String: (Int, Data)] = [:]
        private(set) var requests: [Recorded] = []
        var offline = false

        func set(_ key: String, status: Int = 200, body: Data = Data(#"{"ok":true}"#.utf8)) {
            lock.lock(); routes[key] = (status, body); lock.unlock()
        }

        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let path = request.url?.path ?? ""
            let bodyText = request.httpBody.map { String(decoding: $0, as: UTF8.self) }
            let object = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let action = object?["action"] as? String
            let recorded = Recorded(method: request.httpMethod ?? "GET", path: path, body: bodyText)
            let answer: (Int, Data)? = lock.withLock {
                requests.append(recorded)
                if offline { return nil }
                if let action, let exact = routes["POST \(path) \(action)"] { return exact }
                return routes["\(request.httpMethod ?? "GET") \(path)"]
            }
            guard let (status, body) = answer else { throw URLError(.notConnectedToInternet) }
            return HTTPResponse(status: status, headers: [:], body: body)
        }

        func requests(action: String) -> [Recorded] {
            lock.lock(); defer { lock.unlock() }
            return requests.filter { $0.body?.contains("\"action\":\"\(action)\"") == true }
        }
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    @MainActor
    private final class Calendar {
        var flips: [(String, Bool)] = []
    }

    private func healthy() -> ScriptedTransport {
        let t = ScriptedTransport()
        t.set("POST /api/workout-sessions bootstrap", body: Self.fixture("bootstrap-peek.json").replacingSessionWithStarted())
        t.set("POST /api/workout-sessions finish", body: Self.fixture("finish.json"))
        t.set("POST /api/workout-sessions")
        t.set("POST /api/completions")
        t.set("POST /api/coach-summary", body: Self.fixture("coach-summary.ndjson"))
        return t
    }

    /// Records what the tracker told the Live Activity (W12).
    private final class ActivitySpy: TrackerActivityPublishing, @unchecked Sendable {
        enum Call: Equatable { case sync(TrackerActivitySnapshot), end(SessionKey, Int?) }
        private let lock = NSLock()
        private var _calls: [Call] = []
        var calls: [Call] { lock.withLock { _calls } }
        func sync(_ snapshot: TrackerActivitySnapshot) async { lock.withLock { _calls.append(.sync(snapshot)) } }
        func end(_ session: SessionKey, totalSeconds: Int?) async { lock.withLock { _calls.append(.end(session, totalSeconds)) } }
    }

    @MainActor
    private func make(
        _ transport: ScriptedTransport, cache: MemoryCacheStore = MemoryCacheStore(),
        store: MemoryWriteQueueStore = MemoryWriteQueueStore(), clock: TestClock = TestClock(now: now),
        calendar: Calendar = Calendar(), event: ScheduleEvent = TrackerModelTests.event,
        activity: any TrackerActivityPublishing = NoActivityPublisher()
    ) -> (TrackerModel, WriteQueue) {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        let queue = WriteQueue(store: store, client: client, clock: clock)
        let services = TrackerServices(client: client, cache: cache, queue: queue, clock: clock, activity: activity)
        let deps = TrackerDependencies(
            services: services,
            definitions: { [ExerciseDefinition(id: "d-row", canonicalName: "Rowing Machine", category: "cardio"),
                            ExerciseDefinition(id: "d-db", canonicalName: "Single-Arm Dumbbell Press", category: "strength", isUnilateral: true),
                            ExerciseDefinition(id: "d-old", canonicalName: "Retired Lift", category: "strength", archivedAt: "2026-01-01T00:00:00.000Z")] },
            onCompletionChanged: { event, isCompleted, _ in calendar.flips.append((event.id, isCompleted)) }
        )
        return (TrackerModel(event: event, deps: deps), queue)
    }

    /// The tracked occurrence, as the Schedule tab would hand it over.
    private static let event: ScheduleEvent = event(scoring: nil)

    /// The same occurrence on a scored template (the fixture series is not one).
    private static func event(scoring: String?) -> ScheduleEvent {
        var object = try! JSONSerialization.jsonObject(with: fixture("schedule.json")) as! [String: Any]
        if let scoring {
            object["bases"] = (object["bases"] as! [[String: Any]]).map { base in
                guard base["id"] as? String == "ios-fixture-weekly" else { return base }
                var scored = base
                scored["templateId"] = "wt-murph"
                scored["scoringType"] = scoring
                return scored
            }
        }
        let schedule = try! JSONDecoder().decode(ScheduleResponse.self, from: try! JSONSerialization.data(withJSONObject: object))
        return ScheduleIndex(schedule).events(on: DayKey("2026-09-22")!).first { $0.id == "ios-fixture-weekly__2026-09-22" }!
    }

    private let press1 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 1)
    private let press2 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 2)

    // MARK: - Open

    @MainActor
    func testOpenOnlineRendersCachesAndQueuesNoStart() async throws {
        let cache = MemoryCacheStore()
        let store = MemoryWriteQueueStore()
        let (model, _) = make(healthy(), cache: cache, store: store)
        await model.open()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.editor.groups.count, 1)
        XCTAssertNotNil(model.startedAt)
        XCTAssertFalse(model.isFinished)
        let cached = try await cache.read(kind: .trackerBootstrap, key: ScheduleCacheKey.trackerBootstrap(eventId: Self.event.id, eventDate: Self.event.date))
        XCTAssertNotNil(cached)
        let ops = await store.all
        XCTAssertTrue(ops.isEmpty)
        XCTAssertEqual(model.definitions.count, 3)
    }

    @MainActor
    func testOpenOfflineWithAPeekStartsTheSessionLocally() async throws {
        let cache = MemoryCacheStore()
        let key = ScheduleCacheKey.trackerBootstrap(eventId: Self.event.id, eventDate: Self.event.date)
        try await cache.write(CacheEntry(kind: .trackerBootstrap, key: key, json: Self.fixture("bootstrap-peek.json"), fetchedAt: Self.now))
        let transport = healthy()
        transport.offline = true
        let store = MemoryWriteQueueStore()
        let clock = TestClock(now: Self.now)
        let (model, _) = make(transport, cache: cache, store: store, clock: clock)
        await model.open()

        XCTAssertEqual(model.phase, .ready, "the cached peek renders")
        XCTAssertEqual(model.startedAt, Self.now, "the phone's time is the start")
        let ops = await store.all
        XCTAssertEqual(ops.map(\.payload), [.start(startedAt: CompletionRows.isoTimestamp(Self.now))])
        // Cached with the synthesised session so a relaunch resumes the same timer.
        let cached = try JSONDecoder().decode(TrackerBootstrap.self, from: try await cache.read(kind: .trackerBootstrap, key: key)!.json)
        XCTAssertEqual(cached.session?.startedAt, CompletionRows.isoTimestamp(Self.now))

        // Back online, but the start is refused once: the bootstrap carries the
        // queued stamp so both paths converge on one started_at.
        transport.offline = false
        transport.set("POST /api/workout-sessions start", status: 503, body: Data("down".utf8))
        let (again, queue) = make(transport, cache: cache, store: store, clock: clock)
        await again.open()
        let boot = transport.requests(action: "bootstrap").last
        XCTAssertTrue(boot?.body?.contains("\"startedAt\":\"\(CompletionRows.isoTimestamp(Self.now))\"") == true, boot?.body ?? "")
        // The 503 retries instantly under the test clock; what matters is that the
        // first start carried the stamp and the bootstrap did too.
        XCTAssertTrue(transport.requests(action: "start").first?.body?.contains(CompletionRows.isoTimestamp(Self.now)) == true)

        transport.set("POST /api/workout-sessions start")
        await queue.awaitRetries()
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    @MainActor
    func testOpenOfflineWithoutACacheIsUnavailable() async {
        let transport = healthy()
        transport.offline = true
        let (model, _) = make(transport)
        await model.open()
        guard case .unavailable = model.phase else { return XCTFail("expected unavailable, got \(model.phase)") }
    }

    // MARK: - Live Activity (W12)

    @MainActor
    func testOpenWithARunningSessionSyncsTheActivityOnce() async throws {
        let spy = ActivitySpy()
        let (model, _) = make(healthy(), activity: spy)
        await model.open()
        guard case .sync(let snapshot)? = spy.calls.first, spy.calls.count == 1 else { return XCTFail("\(spy.calls)") }
        XCTAssertEqual(snapshot.session, model.session)
        XCTAssertEqual(snapshot.title, Self.event.title)
        XCTAssertEqual(snapshot.startedAt, model.startedAt, "the island counts from the server's started_at")
        XCTAssertEqual(snapshot.exerciseCount, model.editor.groups.reduce(0) { $0 + $1.exercises.count })
        // Back keeps it up: the workout is still going.
        await model.close()
        XCTAssertEqual(spy.calls.count, 1)
    }

    @MainActor
    func testOfflineStartSyncsWithTheLocalStamp() async throws {
        let cache = MemoryCacheStore()
        let key = ScheduleCacheKey.trackerBootstrap(eventId: Self.event.id, eventDate: Self.event.date)
        try await cache.write(CacheEntry(kind: .trackerBootstrap, key: key, json: Self.fixture("bootstrap-peek.json"), fetchedAt: Self.now))
        let transport = healthy()
        transport.offline = true
        let spy = ActivitySpy()
        let (model, _) = make(transport, cache: cache, activity: spy)
        await model.open()
        XCTAssertEqual(spy.calls, [.sync(TrackerActivitySnapshot(
            session: model.session, title: Self.event.title, startedAt: Self.now,
            exerciseCount: model.editor.groups.reduce(0) { $0 + $1.exercises.count }
        ))])
    }

    @MainActor
    func testUnavailableAndFinishedSessionsSyncNothing() async throws {
        let offline = healthy()
        offline.offline = true
        let spy = ActivitySpy()
        let (unavailable, _) = make(offline, activity: spy)
        await unavailable.open()
        XCTAssertTrue(spy.calls.isEmpty, "nothing to count without a session")

        let transport = healthy()
        transport.set("POST /api/workout-sessions bootstrap", body: Self.fixture("bootstrap.json"))
        let (finished, _) = make(transport, activity: spy)
        await finished.open()
        XCTAssertTrue(finished.isFinished)
        XCTAssertTrue(spy.calls.isEmpty, "a finished session reopened starts no activity")
    }

    @MainActor
    func testFinishEndsWithTheTotalAndCancelEndsAtOnce() async throws {
        let spy = ActivitySpy()
        let (model, queue) = make(healthy(), activity: spy)
        await model.open()
        await model.requestFinish(force: true)
        XCTAssertEqual(spy.calls.last, .end(model.session, model.totalDurationSeconds))
        XCTAssertNotNil(model.totalDurationSeconds)
        await queue.flush(model.session)

        model.confirmCancel()
        _ = await model.cancelWorkout()
        XCTAssertEqual(spy.calls.last, .end(model.session, nil))
        XCTAssertEqual(spy.calls.count, 3, "sync, end(total), end(nil)")
    }

    // MARK: - Edits

    @MainActor
    func testEditsDebounceIntoOneSaveAndTheGhostCommitsOnFocus() async throws {
        let transport = healthy()
        let store = MemoryWriteQueueStore()
        let (model, _) = make(transport, store: store)
        await model.open()

        XCTAssertTrue(model.focusSet(at: press2), "the shadow commits on first focus")
        XCTAssertEqual(model.set(at: press2)?.actualWeight, "110 lb")
        XCTAssertFalse(model.focusSet(at: press2))
        model.setValue("115 lb", .weight, at: press2)
        model.setValue("4", .reps, at: press2)
        XCTAssertEqual(model.loggedSetCount, 1)

        await model.flushEdits()
        let saves = transport.requests(action: "save")
        XCTAssertEqual(saves.count, 1, "three edits, one save")
        XCTAssertTrue(saves[0].body!.contains(#""actual_weight":"115 lb""#))
        XCTAssertTrue(saves[0].body!.contains(#""actual_reps":"4""#))
        let w1 = await store.all.count
        XCTAssertEqual(w1, 0)
        XCTAssertTrue(model.sync.isIdle)
    }

    @MainActor
    func testOfflineEditsShowAsPendingAndFlushLater() async throws {
        let transport = healthy()
        let store = MemoryWriteQueueStore()
        let (model, queue) = make(transport, store: store)
        await model.open()
        transport.offline = true
        model.focusSet(at: press2)
        await model.flushEdits()
        XCTAssertEqual(model.sync.pendingSets, 1)
        XCTAssertEqual(model.syncLabel, "1 set pending sync")

        transport.offline = false
        await queue.awaitRetries()
        await queue.flush()
        let w2 = await store.all.count
        XCTAssertEqual(w2, 0)
    }

    // MARK: - Finish

    @MainActor
    func testFinishGateAsksAboutUnloggedSetsThenQueuesFinishAndCompletion() async throws {
        let transport = healthy()
        let store = MemoryWriteQueueStore()
        let calendar = Calendar()
        let (model, queue) = make(transport, store: store, calendar: calendar)
        await model.open()

        await model.requestFinish()
        XCTAssertEqual(model.gate, .needsConfirm(count: 2), "both planned sets are untouched")
        model.keepGoing()
        XCTAssertEqual(model.gate, .idle)

        model.focusSet(at: press1)
        await model.requestFinish()
        XCTAssertEqual(model.gate, .needsConfirm(count: 1))
        await model.requestFinish(force: true)
        await queue.flush(model.session)

        XCTAssertTrue(model.isFinished)
        XCTAssertEqual(model.gate, .idle)
        XCTAssertEqual(calendar.flips.map(\.1), [true])
        let finish = try XCTUnwrap(transport.requests(action: "finish").first)
        XCTAssertTrue(finish.body!.contains(#""set_number":2"#), "the untouched set was zero-filled")
        XCTAssertTrue(finish.body!.contains(#""is_autofilled":true"#))
        // The test clock jumps on every debounce sleep, so only the minute is stable.
        XCTAssertTrue(finish.body!.contains("\"finishedAt\":\"2026-09-22T12:00:"), finish.body!)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/completions" }.count, 1)
        XCTAssertEqual(model.set(at: press2)?.isAutofilled, true)

        // The queue's .finished event fills the summary and streams the coach.
        let deadline = Date().addingTimeInterval(2)
        while model.summary?.pendingSync != false, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        let summary = try XCTUnwrap(model.summary)
        XCTAssertFalse(summary.pendingSync, "summary=\(summary) sync=\(model.sync) requests=\(transport.requests.map { $0.body ?? $0.path })")
        XCTAssertEqual(summary.prs.map(\.exerciseName), ["Fixture Press"])
        XCTAssertEqual(summary.durationSeconds, 1800)
        while model.summary?.coachStatus == .loading, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.summary?.coachStatus, .ready)
        XCTAssertEqual(model.summary?.coachText, "Strong session — a new estimated 1RM on Fixture Press.")
        XCTAssertEqual(model.prCount, 1)
        XCTAssertEqual(model.completedCount, 1)
    }

    @MainActor
    func testScoredTemplateAsksForAScoreAndSendsIt() async throws {
        let transport = healthy()
        transport.set("POST /api/workout-sessions bootstrap", body: Self.fixture("bootstrap-peek.json").replacingSessionWithStarted().withScored())
        let (model, queue) = make(transport, event: Self.event(scoring: "for-time"))
        await model.open()
        model.focusSet(at: press1)
        model.focusSet(at: press2)
        await model.requestFinish()
        XCTAssertEqual(model.gate, .needsScore)
        await model.requestFinish(force: true, score: .entered(.forTime(timeSeconds: 2492)))
        await queue.flush(model.session)
        let finish = try XCTUnwrap(transport.requests(action: "finish").first)
        XCTAssertTrue(finish.body!.contains(#""score":{"templateId":"wt-murph","timeSeconds":2492,"type":"for-time"}"#), finish.body!)
        XCTAssertEqual(model.summary?.score, .forTime(timeSeconds: 2492))
    }

    @MainActor
    func testSkippingTheScoreFinishesUnscored() async throws {
        let transport = healthy()
        transport.set("POST /api/workout-sessions bootstrap", body: Self.fixture("bootstrap-peek.json").replacingSessionWithStarted().withScored())
        let (model, queue) = make(transport, event: Self.event(scoring: "amrap"))
        await model.open()
        await model.requestFinish(force: true, score: .skipped)
        await queue.flush(model.session)
        XCTAssertTrue(model.isFinished)
        let finish = try XCTUnwrap(transport.requests(action: "finish").first)
        XCTAssertFalse(finish.body!.contains("\"score\""))
    }

    @MainActor
    func testFinishOfflineShowsPendingSyncThenFillsIn() async throws {
        let transport = healthy()
        let store = MemoryWriteQueueStore()
        let (model, queue) = make(transport, store: store)
        await model.open()
        transport.offline = true
        await model.requestFinish(force: true)

        XCTAssertTrue(model.isFinished)
        let pending = try XCTUnwrap(model.summary)
        XCTAssertTrue(pending.pendingSync)
        XCTAssertEqual(pending.coachStatus, .unavailable(TrackerModel.summaryPendingSync))
        XCTAssertEqual(pending.durationSeconds, model.elapsed)
        let ops = await store.all.map(\.payload.action)
        XCTAssertEqual(ops.filter { $0 == .finish }.count, 1)
        XCTAssertEqual(ops.filter { $0 == .completion }.count, 1)

        transport.offline = false
        await queue.awaitRetries()
        await queue.flush()
        let deadline = Date().addingTimeInterval(2)
        while model.summary?.pendingSync != false, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.summary?.prs.count, 1)
        XCTAssertEqual(model.summary?.durationSeconds, 1800)
    }

    // MARK: - Cancel

    @MainActor
    func testCancelPurgesTheSessionSendsCancelAndFlipsAFinishedSessionBack() async throws {
        let transport = healthy()
        let store = MemoryWriteQueueStore()
        let calendar = Calendar()
        let (model, queue) = make(transport, store: store, calendar: calendar)
        await model.open()
        await model.requestFinish(force: true)
        await queue.flush(model.session)
        model.confirmCancel()
        XCTAssertEqual(model.gate, .confirmCancel)
        let ok = await model.cancelWorkout()
        XCTAssertTrue(ok)
        XCTAssertEqual(calendar.flips.map(\.1), [true, false])
        await queue.flush(model.session)
        XCTAssertEqual(transport.requests(action: "cancel").count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/completions" }.count, 2)
        let w3 = await store.all.count
        XCTAssertEqual(w3, 0)
    }

    // MARK: - Swap

    @MainActor
    func testSwapFlushesThePendingSaveFirstAndRelabels() async throws {
        let transport = healthy()
        let (model, _) = make(transport)
        await model.open()
        model.setValue("10", .reps, at: press1)
        let db = model.definitions.first { $0.id == "d-db" }!
        await model.swap(section: "exercise", exerciseId: "fx-press", to: db)

        let order = transport.requests.compactMap { r -> String? in
            for action in ["save", "swap-exercise"] where r.body?.contains("\"action\":\"\(action)\"") == true { return action }
            return nil
        }
        XCTAssertEqual(order, ["save", "swap-exercise"])
        let press = model.editor.exercise(section: "exercise", id: "fx-press")!
        XCTAssertEqual(press.exercise.name, "Single-Arm Dumbbell Press")
        XCTAssertEqual(press.substitutedFrom, "Fixture Press")
        XCTAssertNotNil(model.perSideWarning(for: press), "10 reps on a unilateral movement, no side stated")
        XCTAssertEqual(model.inputFields(for: press), [.weight, .reps])
    }

    @MainActor
    func testSwapCandidatesKeepTheLoggedShapeAndHideArchived() async {
        let (model, _) = make(healthy())
        await model.open()
        let press = TrackedExercise(section: "exercise", exercise: Exercise(id: "x", name: "Press", category: "strength"), isCardio: false, sets: [])
        let row = TrackedExercise(section: "exercise", exercise: Exercise(id: "r", name: "Row", category: "cardio"), isCardio: true, sets: [], cardio: CardioLog())
        XCTAssertEqual(TrackerModel.swapCandidates(model.definitions, for: press, query: "").map(\.id), ["d-db"])
        XCTAssertEqual(TrackerModel.swapCandidates(model.definitions, for: row, query: "").map(\.id), ["d-row"])
        XCTAssertEqual(TrackerModel.swapCandidates(model.definitions, for: press, query: "nothing").count, 0)
        XCTAssertEqual(TrackerModel.swapCandidates(model.definitions, for: press, query: "dumbbell").map(\.id), ["d-db"])
    }

    // MARK: - Reopen

    @MainActor
    func testReopeningAFinishedSessionUsesTheSavedSummary() async throws {
        let transport = healthy()
        transport.set("POST /api/workout-sessions bootstrap", body: Self.fixture("bootstrap.json").withCoachSummary("Saved words."))
        let (model, _) = make(transport)
        await model.open()
        XCTAssertTrue(model.isFinished)
        XCTAssertEqual(model.elapsed, 1800)
        XCTAssertEqual(model.savedPRs.map(\.exerciseName), ["Fixture Press"])
        await model.openSavedSummary()
        XCTAssertEqual(model.summary?.coachStatus, .ready)
        XCTAssertEqual(model.summary?.coachText, "Saved words.")
        XCTAssertEqual(model.summary?.prs.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/coach-summary" }.count, 0, "no request when the text is saved")

        // Edits on a finished session still save.
        model.setValue("137", .weight, at: press1)
        await model.flushEdits()
        XCTAssertEqual(transport.requests(action: "save").count, 1)
    }

    @MainActor
    func testCoachSummaryDegradesOn409And402AndInBandError() async {
        for (status, body, expected) in [
            (409, Data("Session not finished".utf8), TrackerModel.summaryPendingSync),
            (402, Data("anthropic-key-missing".utf8), TrackerModel.coachUnavailable),
            (200, Data("{\"type\":\"error\",\"message\":\"Summary generation failed\"}\n".utf8), TrackerModel.coachUnavailable),
            (200, Data("{\"type\":\"done\"}\n".utf8), TrackerModel.coachUnavailable),
        ] {
            let transport = healthy()
            transport.set("POST /api/workout-sessions bootstrap", body: Self.fixture("bootstrap.json"))
            transport.set("POST /api/coach-summary", status: status, body: body)
            let (model, _) = make(transport)
            await model.open()
            await model.openSavedSummary()
            XCTAssertEqual(model.summary?.coachStatus, .unavailable(expected), "status \(status)")
        }
    }

    @MainActor
    func testNextFieldWalksInReadingOrder() async {
        let (model, _) = make(healthy())
        await model.open()
        XCTAssertEqual(model.nextField(after: .set(press1, .weight)), .set(press1, .reps))
        XCTAssertEqual(model.nextField(after: .set(press1, .reps)), .set(press2, .weight))
        let row = CardioKey(section: "exercise", exerciseId: "fx-row")
        XCTAssertEqual(model.nextField(after: .set(press2, .reps)), .cardio(row, .durationMinutes))
        XCTAssertNil(model.nextField(after: .cardio(row, .avgHeartRate)))
    }
}

private extension Data {
    /// The peek fixture with a started, unfinished session — what a real
    /// `bootstrap` answers for a workout being opened for the first time.
    func replacingSessionWithStarted() -> Data {
        var object = try! JSONSerialization.jsonObject(with: self) as! [String: Any]
        object["session"] = [
            "id": "s-1", "user_id": "u-1", "event_id": "ios-fixture-weekly__2026-09-22", "event_date": "2026-09-22",
            "started_at": "2026-09-22T11:30:00.000Z", "finished_at": NSNull(), "updated_at": NSNull(),
            "total_duration_seconds": NSNull(), "coach_summary": NSNull(), "template_id": NSNull(),
            "score_type": NSNull(), "score_time_seconds": NSNull(), "score_rounds": NSNull(), "score_reps": NSNull(),
        ]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    /// The server's verdict for a scored template.
    func withScored() -> Data {
        var object = try! JSONSerialization.jsonObject(with: self) as! [String: Any]
        object["scored"] = true
        return try! JSONSerialization.data(withJSONObject: object)
    }

    func withCoachSummary(_ text: String) -> Data {
        var object = try! JSONSerialization.jsonObject(with: self) as! [String: Any]
        var session = object["session"] as! [String: Any]
        session["coach_summary"] = text
        object["session"] = session
        return try! JSONSerialization.data(withJSONObject: object)
    }
}
