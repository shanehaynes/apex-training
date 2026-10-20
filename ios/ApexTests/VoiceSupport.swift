import ApexCore
import ApexFeatures
import ApexSpeech
import Foundation
import XCTest

/// What the W17 voice tests share: the tracker over the fixtures, a scripted
/// or step-wise fake recognizer, an in-memory queue and journal, a test clock.
enum VoiceSupport {
    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    static func fixture(_ name: String) -> Data {
        try! Data(contentsOf: fixtures.appendingPathComponent(name))
    }

    /// 2026-09-22T12:00:00Z — the tracked occurrence's day.
    static let now = Date(timeIntervalSince1970: 1_790_078_400)

    static let press1 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 1)
    static let press2 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 2)
    static let press3 = SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 3)

    /// The fixture's own definition plus a library entry not in today's
    /// session, a cardio one, and an archived one.
    static let library = [
        ExerciseDefinition(id: "ios-fixture-def", canonicalName: "Fixture Press", aliases: ["fx press"], category: "strength"),
        ExerciseDefinition(id: "rdl", canonicalName: "Romanian Deadlift", aliases: ["Stiff-Leg Deadlift"], category: "strength"),
        ExerciseDefinition(id: "d-row", canonicalName: "Rowing Machine", category: "cardio"),
        ExerciseDefinition(id: "d-old", canonicalName: "Retired Lift", category: "strength", archivedAt: "2026-01-01T00:00:00.000Z"),
    ]

    /// The tracked occurrence, as the Schedule tab would hand it over.
    static let event: ScheduleEvent = {
        let schedule = try! JSONDecoder().decode(ScheduleResponse.self, from: fixture("schedule.json"))
        return ScheduleIndex(schedule).events(on: DayKey("2026-09-22")!).first { $0.id == "ios-fixture-weekly__2026-09-22" }!
    }()

    /// The peek fixture with a started, unfinished session; `full` serves
    /// bootstrap-full.json reopened (a pitch, two cardio rows, a squat).
    static func bootstrap(full: Bool) -> Data {
        var object = try! JSONSerialization.jsonObject(with: fixture(full ? "bootstrap-full.json" : "bootstrap-peek.json")) as! [String: Any]
        if full {
            var session = object["session"] as! [String: Any]
            session["finished_at"] = NSNull()
            object["session"] = session
            object["prs"] = []
            object["scoreRecord"] = NSNull()
        } else {
            object["session"] = [
                "id": "s", "user_id": "u", "event_id": "ios-fixture-weekly__2026-09-22", "event_date": "2026-09-22",
                "started_at": "2026-09-22T11:18:00.000Z",
            ]
        }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    /// Reads the time but never finishes a sleep: the autosave debounce never
    /// fires, so a test can act "before the flush".
    struct StalledClock: ApexClock {
        let now: Date
        func sleep(seconds: Double) async throws { try await Task.sleep(for: .seconds(3600)) }
    }

    struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    /// Answers the tracker's routes from the fixtures and records every save.
    final class Transport: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _bodies: [String] = []
        var full = false

        func send(_ request: URLRequest) async throws -> HTTPResponse {
            let path = request.url?.path ?? ""
            let body = request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
            lock.withLock { _bodies.append(body) }
            let action = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])?["action"] as? String
            switch (path, action) {
            case ("/api/workout-sessions", "bootstrap"): return HTTPResponse(status: 200, headers: [:], body: VoiceSupport.bootstrap(full: full))
            case ("/api/workout-sessions", "finish"): return HTTPResponse(status: 200, headers: [:], body: VoiceSupport.fixture("finish.json"))
            case ("/api/coach-summary", _): return HTTPResponse(status: 200, headers: [:], body: VoiceSupport.fixture("coach-summary.ndjson"))
            default: return HTTPResponse(status: 200, headers: [:], body: Data(#"{"ok":true}"#.utf8))
            }
        }

        /// Every request body carrying `"action":"<action>"`, in order.
        func bodies(action: String) -> [String] {
            lock.withLock { _bodies.filter { $0.contains("\"action\":\"\(action)\"") } }
        }
    }

    struct Made {
        let model: TrackerModel
        let queue: WriteQueue
        let store: MemoryWriteQueueStore
        let transport: Transport
        let fake: FakeSpeechRecognizer
        let clock: TestClock
        let journal: MemoryVoiceJournalStore
    }

    @MainActor
    static func make(
        script: [String] = [], authorization: SpeechAuthorization = .authorized,
        availability: SpeechAvailability = .available(locale: "en-US"), grantOnRequest: Bool = true,
        full: Bool = false, library: [ExerciseDefinition] = library, stalled: Bool = false
    ) async -> Made {
        let transport = Transport()
        transport.full = full
        let clock = TestClock(now: now)
        // `stalled` hands the model a clock whose sleeps never return (the
        // debounce never flushes); `Made.clock` is then only the fixed time.
        let modelClock: any ApexClock = stalled ? StalledClock(now: now) : clock
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: Tokens())
        let store = MemoryWriteQueueStore()
        let queue = WriteQueue(store: store, client: client, clock: modelClock)
        let fake = FakeSpeechRecognizer(authorization: authorization, availability: availability, script: script, grantOnRequest: grantOnRequest)
        let journal = MemoryVoiceJournalStore()
        let services = TrackerServices(client: client, cache: MemoryCacheStore(), queue: queue, clock: modelClock, speech: fake, journal: journal)
        let deps = TrackerDependencies(services: services, definitions: { library }, onCompletionChanged: { _, _, _ in })
        let model = TrackerModel(event: event, deps: deps)
        await model.open()
        return Made(model: model, queue: queue, store: store, transport: transport, fake: fake, clock: clock, journal: journal)
    }

    /// Polls for up to two real seconds: the model consumes the fake's events
    /// on the main actor, one hop after the test yields.
    @MainActor
    static func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "timed out waiting", file: file, line: line)
    }

    /// The toggle on for a test, and back after.
    @MainActor
    static func withVoiceEnabled(_ on: Bool = true, _ body: () async throws -> Void) async rethrows {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: TrackerModel.voicePreferenceKey)
        defaults.set(on, forKey: TrackerModel.voicePreferenceKey)
        defer { if let previous { defaults.set(previous, forKey: TrackerModel.voicePreferenceKey) } else { defaults.removeObject(forKey: TrackerModel.voicePreferenceKey) } }
        try await body()
    }
}

extension VoiceLogState {
    var isApplied: Bool { if case .applied = self { return true } else { return false } }
    var isListening: Bool { if case .listening = self { return true } else { return false } }
    var isFinishing: Bool { if case .finishing = self { return true } else { return false } }
    var isConfirming: Bool { if case .confirming = self { return true } else { return false } }
    var appliedLabel: String? { if case .applied(_, let label) = self { return label } else { return nil } }
    var applied: VoiceApplied? { if case .applied(let applied, _) = self { return applied } else { return nil } }
    var candidates: [SpokenExercise.Candidate]? { if case .confirming(_, let candidates) = self { return candidates } else { return nil } }
}
