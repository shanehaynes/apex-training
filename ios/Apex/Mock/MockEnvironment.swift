#if DEBUG
import ApexCore
import Foundation

/// The in-process backend behind `-apexMockClient`: every `/api/*` route the
/// Schedule tab uses, answered from `ios/Fixtures/` (bundled into Debug builds
/// as a folder reference), a fixed clock so "today" is the fixture day, a
/// throwaway cache, and any-credentials auth.
///
///   -apexMockClient                 turn it on
///   -apexMockFail completions       make POST /api/completions answer 500
///   -apexMockFailOnce save 3        make the first 3 `save` actions (or a path
///                                   suffix) answer 500, then succeed — the
///                                   write queue's pending → synced path
///   -apexMockHasKey                 the profile reports an Anthropic key, so the
///                                   coach opens on the thread instead of the
///                                   key-setup state (the fixture has no key)
///
/// W7: the sheet's and the builder's writes (`/api/events`, `/api/event-instances`,
/// `/api/workout-draft`, templates, definitions) are remembered and replayed
/// into later schedule reads, so a smoke sees what it just changed.
struct MockEnvironment {
    /// 2026-09-08T12:00:00Z — the day the fixtures put four events on.
    let clock: any ApexClock = TestClock(now: Date(timeIntervalSince1970: 1_788_868_800))
    let cache: any CacheStore = MemoryCacheStore()
    let tokens: any TokenProvider = StaticTokenProvider()
    let transport: FixtureTransport
    let streams: FixtureStreams

    init() {
        let failing = Self.argument("-apexMockFail")
        var failOnce: (route: String, count: Int)?
        if let route = Self.argument("-apexMockFailOnce") {
            failOnce = (route, Int(Self.argument(after: route) ?? "") ?? 1)
        }
        transport = FixtureTransport(
            failingRoute: failing, failOnce: failOnce, clock: clock,
            hasKey: CommandLine.arguments.contains("-apexMockHasKey")
        )
        streams = FixtureStreams()
    }

    static func argument(after value: String) -> String? {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: value), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static func argument(_ name: String) -> String? {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
}

nonisolated struct StaticTokenProvider: TokenProvider {
    func accessToken() async throws -> String { "mock" }
    func refresh() async throws -> String { "mock" }
    func signOut() async {}
}

nonisolated enum Fixtures {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "Fixtures") else {
            throw APIError.server(status: 404, message: "no bundled fixture \(name)")
        }
        return try Data(contentsOf: url)
    }
}

/// Routes by method + path; the body decides between variants. Completion
/// writes are remembered and reflected in later schedule reads, the way the
/// real server would — the model re-reads the window after every toggle.
actor FixtureTransport: HTTPTransport {
    private let failingRoute: String?
    private var failOnce: (route: String, count: Int)?
    private let clock: any ApexClock
    private(set) var requests: [(method: String, path: String, body: Data?)] = []
    private var completions: [String: (isCompleted: Bool, completedAt: String?)] = [:]
    /// Flipped by `-apexMockHasKey` and by a PATCH that saves or removes one.
    private var hasKey: Bool
    /// W7: every write the sheet and the builder make, replayed into later
    /// schedule reads the way the completions are.
    private var edits = ScheduleEdits()
    private var minted = 0

    struct ScheduleEdits {
        /// camelCase field overrides per base id (PATCH /api/events, update).
        var patched: [String: [String: Any]] = [:]
        var deletedBases: Set<String> = []
        var removedStubs: Set<String> = []
        /// Per-occurrence moves keyed by stub id.
        var moved: [String: [String: Any]] = [:]
        /// Created and detached events: a base plus its one stub.
        var added: [(base: [String: Any], stub: [String: Any])] = []
        var archivedTemplates: [String: Any] = [:]
        var addedDefinitions: [[String: Any]] = []
    }

    init(failingRoute: String?, failOnce: (route: String, count: Int)? = nil, clock: any ApexClock, hasKey: Bool = false) {
        self.failingRoute = failingRoute
        self.failOnce = failOnce
        self.clock = clock
        self.hasKey = hasKey
    }

    /// The coach stream arrives line by line, a beat apart, so the typing
    /// indicator and the cursor are real on the simulator; every other route
    /// streams its `send` body in one chunk.
    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        guard request.httpMethod == "POST", request.url?.path == "/api/chat" else {
            return HTTPStreamResponse(try await send(request))
        }
        let response = try await send(request)
        guard response.status == 200 else { return HTTPStreamResponse(response) }
        let lines = String(decoding: response.body, as: UTF8.self).split(separator: "\n").map { String($0) + "\n" }
        let (bytes, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let producer = Task {
            try? await Task.sleep(for: .milliseconds(350))
            for line in lines {
                guard !Task.isCancelled else { break }
                continuation.yield(Data(line.utf8))
                try? await Task.sleep(for: .milliseconds(120))
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in producer.cancel() }
        return HTTPStreamResponse(status: response.status, headers: response.headers, bytes: bytes)
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let query = request.url?.query ?? ""
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let action = body?["action"] as? String
        requests.append((method, path, request.httpBody))
        // The real thing takes a moment; so does this, so loading states render.
        try? await Task.sleep(for: .milliseconds(120))

        if let failingRoute, path.hasSuffix(failingRoute) || action == failingRoute {
            return HTTPResponse(status: 500, headers: [:], body: Data("mock failure".utf8))
        }
        if let once = failOnce, once.count > 0, path.hasSuffix(once.route) || action == once.route {
            failOnce = (once.route, once.count - 1)
            return HTTPResponse(status: 500, headers: [:], body: Data("mock failure (once)".utf8))
        }
        do {
            switch (method, path) {
            case ("GET", "/api/schedule"):
                // Past the series' UNTIL: the empty window.
                let start = query.split(separator: "&").first { $0.hasPrefix("start=") }?.dropFirst(6) ?? ""
                return ok(applyEdits(to: applyCompletions(to: try Fixtures.data(start >= "2026-10-28" ? "schedule-empty.json" : "schedule.json"))))
            case ("GET", "/api/profile"):
                return ok(withKey(try Fixtures.data("profile.json")))
            case ("PATCH", "/api/profile"):
                if let entry = body?["anthropic_api_key"] {
                    hasKey = !(entry is NSNull)
                }
                return ok(Data(#"{"ok":true,"hasAnthropicKey":\(hasKey),"anthropicKeyLast4":\(hasKey ? "\"mock\"" : "null")}"#.utf8))
            case ("POST", "/api/chat"):
                guard hasKey else { return HTTPResponse(status: 402, headers: [:], body: Data("anthropic-key-missing".utf8)) }
                return HTTPResponse(
                    status: 200, headers: ["Content-Type": "application/x-ndjson; charset=utf-8"],
                    body: try chatBody(body)
                )
            case ("POST", "/api/coach-tool"):
                if body?["name"] as? String == "update_workout_draft" {
                    return ok(try reducedDraft(body))
                }
                return ok(try Fixtures.data("coach-tool.json"))
            case ("PATCH", "/api/events"):
                let id = queryValue("id", in: query)
                let fields = body?["fields"] as? [String: Any] ?? [:]
                var patch = edits.patched[id] ?? [:]
                for (key, value) in fields { patch[Self.camel(key)] = value }
                edits.patched[id] = patch
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("DELETE", "/api/events"):
                edits.deletedBases.insert(queryValue("id", in: query))
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("POST", "/api/event-instances"):
                guard let eventId = body?["eventId"] as? String, let date = body?["date"] as? String,
                      let stubId = try stubId(baseId: eventId, originalDate: date) else {
                    return HTTPResponse(status: 404, headers: [:], body: Data("Event not found".utf8))
                }
                if let overrides = body?["overrides"] as? [String: Any] {
                    edits.moved[stubId] = overrides
                } else {
                    edits.removedStubs.insert(stubId)
                }
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("POST", "/api/workout-draft"):
                return ok(try applyDraft(body))
            case ("PATCH", "/api/workout-templates"):
                edits.archivedTemplates[queryValue("id", in: query)] = body?["archived_at"] ?? NSNull()
                return ok(Data(#"{"id":"\(queryValue("id", in: query))"}"#.utf8))
            case ("POST", "/api/exercise-definitions"):
                edits.addedDefinitions.append([
                    "id": body?["id"] ?? "", "canonicalName": body?["canonical_name"] ?? "", "category": body?["category"] ?? "strength",
                    "aliases": [], "muscleGroups": [], "equipment": [], "isUnilateral": body?["is_unilateral"] ?? false,
                ])
                return ok(Data(#"{"id":"\(body?["id"] as? String ?? "")"}"#.utf8))
            case ("POST", "/api/query"):
                let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let tool = body?["tool"] as? String ?? "unknown"
                return ok(try Fixtures.data("query-\(tool).json"))
            case ("POST", "/api/completions"):
                if let body = request.httpBody,
                   let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                   let row = object["completionRow"] as? [String: Any],
                   let id = row["event_id"] as? String {
                    completions[id] = (row["is_completed"] as? Bool ?? false, row["completed_at"] as? String)
                }
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("POST", "/api/workout-sessions"):
                switch action {
                case "bootstrap" where body?["peek"] as? Bool == true:
                    return ok(try Fixtures.data("bootstrap-peek.json"))
                case "bootstrap":
                    // A session started now, the way the real handler creates one —
                    // the committed bootstrap.json is a finished session, which is
                    // what a reopen shows, not what Start Workout should.
                    return ok(startedBootstrap(try Fixtures.data("bootstrap-peek.json"), eventId: body?["eventId"] as? String, eventDate: body?["eventDate"] as? String))
                case "finish":
                    return ok(try Fixtures.data("finish.json"))
                default:
                    return ok(Data(#"{"ok":true}"#.utf8))
                }
            case ("POST", "/api/coach-summary"):
                return HTTPResponse(
                    status: 200, headers: ["Content-Type": "application/x-ndjson; charset=utf-8"],
                    body: try Fixtures.data("coach-summary.ndjson")
                )
            default:
                return HTTPResponse(status: 404, headers: [:], body: Data("no fixture for \(method) \(path)".utf8))
            }
        } catch {
            return HTTPResponse(status: 404, headers: [:], body: Data(String(describing: error).utf8))
        }
    }

    /// Tools on → the recorded `chat-stream.ndjson` (text, a labelled
    /// `delete_event`, done). Tools off → a synthesised reply: the briefing for
    /// Coach's Notes, the confirmation for a flushed tool_result, a line of
    /// Markdown otherwise — so the smoke and the snapshots see every state.
    private func chatBody(_ body: [String: Any]?) throws -> Data {
        if body?["withTools"] as? Bool == true { return try Fixtures.data("chat-stream.ndjson") }
        let messages = body?["messages"] as? [[String: Any]] ?? []
        let last = messages.last
        let text: String
        if let content = last?["content"] as? String, content == ChatCopy.notesPrompt {
            text = "**Today** — Fixture Push Day at 17:30.\n\n- Warm up the shoulders first\n- Last time you pressed 110 lb; aim for 115\n\nKeep the run easy tomorrow."
        } else if let blocks = last?["content"] as? [[String: Any]], blocks.contains(where: { $0["type"] as? String == "tool_result" }) {
            text = "Done — Fixture Push Day on 2026-09-29 is cleared."
        } else {
            text = "Noted. Anything else?"
        }
        let deltas = text.split(separator: " ", omittingEmptySubsequences: false).enumerated().map { index, word in
            #"{"type":"text","delta":"\#((index == 0 ? "" : " ") + word.replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n"))"}"#
        }
        return Data((deltas + [#"{"type":"done"}"#]).joined(separator: "\n").appending("\n").utf8)
    }

    private func withKey(_ data: Data) -> Data {
        guard var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
        object["hasAnthropicKey"] = hasKey
        object["anthropicKeyLast4"] = hasKey ? "mock" : NSNull()
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }

    private func startedBootstrap(_ data: Data, eventId: String?, eventDate: String?) -> Data {
        guard var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
        object["session"] = [
            "id": "mock-session", "user_id": "ios-fixture-user",
            "event_id": eventId ?? "ios-fixture-weekly__2026-09-08", "event_date": eventDate ?? "2026-09-08",
            "started_at": CompletionRows.isoTimestamp(clock.now.addingTimeInterval(-7 * 60)),
        ]
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }

    private func applyCompletions(to data: Data) -> Data {
        guard !completions.isEmpty,
              var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let stubs = object["occurrences"] as? [[String: Any]] else { return data }
        object["occurrences"] = stubs.map { stub -> [String: Any] in
            guard let id = stub["id"] as? String, let write = completions[id] else { return stub }
            var flipped = stub
            flipped["isCompleted"] = write.isCompleted
            flipped["completedAt"] = write.completedAt ?? NSNull()
            return flipped
        }
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }

    private func ok(_ data: Data) -> HTTPResponse {
        HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: data)
    }

    // MARK: - W7 writes

    private func queryValue(_ name: String, in query: String) -> String {
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            if parts.count == 2, parts[0] == name { return String(parts[1]).removingPercentEncoding ?? String(parts[1]) }
        }
        return ""
    }

    private static func camel(_ snake: String) -> String {
        let parts = snake.split(separator: "_")
        return parts.enumerated().map { $0.offset == 0 ? String($0.element) : $0.element.prefix(1).uppercased() + $0.element.dropFirst() }.joined()
    }

    private func scheduleObject() throws -> [String: Any] {
        (try JSONSerialization.jsonObject(with: try Fixtures.data("schedule.json")) as? [String: Any]) ?? [:]
    }

    /// The stub `/api/event-instances` keys on: same base, same original date.
    private func stubId(baseId: String, originalDate: String) throws -> String? {
        let stubs = try scheduleObject()["occurrences"] as? [[String: Any]] ?? []
        let known = stubs.first { $0["baseId"] as? String == baseId && $0["originalDate"] as? String == originalDate }
        if let id = known?["id"] as? String { return id }
        return edits.added.first { $0.stub["baseId"] as? String == baseId && $0.stub["originalDate"] as? String == originalDate }?.stub["id"] as? String
    }

    /// The reduce: the fixture's answer, with the caller's own date kept so the
    /// form stays on the day it opened on.
    private func reducedDraft(_ body: [String: Any]?) throws -> Data {
        guard var object = (try JSONSerialization.jsonObject(with: try Fixtures.data("coach-tool-draft.json"))) as? [String: Any],
              var draft = object["draft"] as? [String: Any] else { return try Fixtures.data("coach-tool-draft.json") }
        if let sent = body?["draft"] as? [String: Any] {
            for key in ["date", "startTime", "endTime", "type", "sport", "duration", "difficulty", "location", "tags", "description"] {
                if let value = sent[key] { draft[key] = value }
            }
            if let title = sent["title"] as? String, !title.isEmpty, (body?["input"] as? [String: Any])?["title"] == nil { draft["title"] = title }
        }
        object["draft"] = draft
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// Apply: the fixture response reshaped around the caller's draft, and
    /// the event remembered for the next schedule read.
    private func applyDraft(_ body: [String: Any]?) throws -> Data {
        let draft = body?["draft"] as? [String: Any] ?? [:]
        let action = body?["action"] as? [String: Any] ?? [:]
        let kind = action["kind"] as? String ?? "create"
        let title = (draft["title"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        if title.isEmpty {
            return try JSONSerialization.data(withJSONObject: ["ok": false, "problem": "Give the workout a title"])
        }
        let fixture = kind == "update" ? "workout-draft-edit.json" : kind == "detach" ? "workout-draft-detach.json" : "workout-draft-create.json"
        guard var object = (try JSONSerialization.jsonObject(with: try Fixtures.data(fixture))) as? [String: Any],
              var event = object["event"] as? [String: Any] else { return try Fixtures.data(fixture) }
        let lists = draft["lists"] as? [String: Any] ?? [:]
        let date = draft["date"] as? String ?? "2026-09-08"
        let repeatOn = (draft["repeat"] as? [String: Any])?["enabled"] as? Bool ?? false
        event["title"] = title
        event["type"] = draft["type"] ?? "weights"
        event["date"] = date
        event["estimatedDuration"] = Int(draft["duration"] as? String ?? "") ?? 60
        event["difficulty"] = draft["difficulty"] ?? 3
        event["startTime"] = TimeLabel.display(draft["startTime"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
        event["endTime"] = TimeLabel.display(draft["endTime"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
        event["exercises"] = lists["exercises"] ?? []
        event["warmup"] = lists["warmup"] ?? []
        event["cooldown"] = lists["cooldown"] ?? []
        event["description"] = draft["description"] ?? ""
        event["location"] = (draft["location"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
        event["isRecurring"] = kind == "create" && repeatOn
        object["date"] = date
        object["isRecurring"] = kind == "create" && repeatOn
        object["completedOnCreate"] = kind == "create" && !repeatOn && date < "2026-09-08"

        switch kind {
        case "update":
            let id = OccurrenceID.baseId(of: action["eventId"] as? String ?? "")
            object["id"] = id
            event["id"] = id
            var patch = edits.patched[id] ?? [:]
            for key in ["title", "type", "estimatedDuration", "difficulty", "exercises", "warmup", "cooldown", "description", "location"] {
                patch[key] = event[key]
            }
            edits.patched[id] = patch
        default:
            minted += 1
            let id = "ai-mock-\(minted)"
            object["id"] = id
            event["id"] = id
            event["isCompleted"] = object["completedOnCreate"] as? Bool ?? false
            if kind == "detach", let occurrence = action["eventId"] as? String {
                object["detachedFrom"] = OccurrenceID.baseId(of: occurrence)
                object["occurrenceDate"] = action["occurrenceDate"] ?? date
                edits.removedStubs.insert(occurrence)
            }
            let stub: [String: Any] = [
                "id": id, "baseId": id, "date": date, "originalDate": date,
                "startTime": event["startTime"] ?? NSNull(), "endTime": event["endTime"] ?? NSNull(),
                "isCompleted": event["isCompleted"] ?? false,
                "completedAt": (event["isCompleted"] as? Bool ?? false) ? CompletionRows.isoTimestamp(clock.now) : NSNull(),
            ]
            edits.added.append((event, stub))
            if event["isRecurring"] as? Bool == true {
                // The server expands a series; here one more week stands in for it.
                var next = stub
                let nextDate = DayKey(date).map { $0.adding(days: 7).string } ?? date
                next["id"] = OccurrenceID.make(baseId: id, date: nextDate)
                next["date"] = nextDate
                next["originalDate"] = nextDate
                next["isCompleted"] = false
                next["completedAt"] = NSNull()
                edits.added.append((event, next))
            }
        }
        object["event"] = event
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func applyEdits(to data: Data) -> Data {
        guard var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
        var bases = object["bases"] as? [[String: Any]] ?? []
        var stubs = object["occurrences"] as? [[String: Any]] ?? []
        bases = bases.filter { !edits.deletedBases.contains($0["id"] as? String ?? "") }
        stubs = stubs.filter { stub in
            guard let id = stub["id"] as? String, let baseId = stub["baseId"] as? String else { return false }
            return !edits.deletedBases.contains(baseId) && !edits.removedStubs.contains(id)
        }
        for (base, stub) in edits.added {
            if let id = base["id"] as? String, !bases.contains(where: { $0["id"] as? String == id }) { bases.append(base) }
            stubs.append(stub)
        }
        bases = bases.map { base in
            guard let id = base["id"] as? String, let patch = edits.patched[id] else { return base }
            return base.merging(patch) { _, new in new }
        }
        stubs = stubs.map { stub in
            guard let id = stub["id"] as? String, let move = edits.moved[id] else { return stub }
            var moved = stub
            if let date = move["date"] { moved["date"] = date }
            if let start = move["startTime"] { moved["startTime"] = start }
            if let end = move["endTime"] { moved["endTime"] = end }
            return moved
        }
        object["bases"] = bases
        object["occurrences"] = stubs
        if var templates = object["templates"] as? [[String: Any]] {
            templates = templates.map { template in
                guard let id = template["id"] as? String, let archived = edits.archivedTemplates[id] else { return template }
                var next = template
                next["archivedAt"] = archived
                return next
            }
            object["templates"] = templates
        }
        if var definitions = object["definitions"] as? [[String: Any]] {
            definitions.append(contentsOf: edits.addedDefinitions)
            object["definitions"] = definitions
        }
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }
}

/// `activity-streams.json` filtered the way the real read is keyed. The
/// fixture rows carry no event id, so the one row belongs to the synced run.
nonisolated struct FixtureStreams: ActivityStreamsReading {
    func record(eventId: String, eventDate: String) async throws -> ActivityStreamRecord? {
        guard eventId == "ios-fixture-run", eventDate == "2026-09-08" else { return nil }
        let rows = try JSONDecoder().decode([ActivityStreamRecord].self, from: try Fixtures.data("activity-streams.json"))
        return rows.first
    }
}
#endif
