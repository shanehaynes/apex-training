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
///   -apexMockCoros expired          the COROS connection starts expired (or
///                                   `disconnected`); the default is connected
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
            hasKey: CommandLine.arguments.contains("-apexMockHasKey"),
            corosStatus: Self.argument("-apexMockCoros") ?? "connected"
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
    /// W11: the You tab's writes, replayed into later reads the way the
    /// schedule edits are. Profile keys are the handler's snake_case names.
    private var profileEdits: [String: Any] = [:]
    private var mintedTokens: [[String: Any]] = []
    private var revokedTokens: Set<String> = []
    private var disconnectedApps: Set<String> = []
    private var corosStatus = "connected"
    private var corosAutoSync = true
    private var corosSynced = false

    /// W9: the dashboard's writes, replayed into later tile reads.
    private var tileEdits = TileEdits()

    struct TileEdits {
        /// Saved tiles (new or edited), in the GET shape, keyed by id.
        var saved: [String: [String: Any]] = [:]
        var layouts: [String: [String: Any]] = [:]
        var deleted: Set<String> = []
    }

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
        /// camelCase overrides per definition id (PATCH /api/exercise-definitions, W10).
        var patchedDefinitions: [String: [String: Any]] = [:]
        /// Blocks and objectives the session wrote, in the tool's snake_case
        /// summary shape (W10). Keyed by id; a deleted block is removed.
        var blocks: [String: [String: Any]] = [:]
        var deletedBlocks: Set<String> = []
        var objectives: [[String: Any]] = []
        /// Meals (snake_case rows with their `date`) and favorites (camelCase,
        /// the GET's shape) the session wrote (W10).
        var meals: [String: [String: Any]] = [:]
        var deletedMeals: Set<String> = []
        var favorites: [String: [String: Any]] = [:]
        var deletedFavorites: Set<String> = []
    }

    init(failingRoute: String?, failOnce: (route: String, count: Int)? = nil, clock: any ApexClock, hasKey: Bool = false, corosStatus: String = "connected") {
        self.failingRoute = failingRoute
        self.failOnce = failOnce
        self.clock = clock
        self.hasKey = hasKey
        self.corosStatus = corosStatus
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
                return ok(withProfileEdits(withKey(unscrubbed(try Fixtures.data("profile.json")))))
            case ("PATCH", "/api/profile"):
                if let entry = body?["anthropic_api_key"] {
                    hasKey = !(entry is NSNull)
                }
                for key in ["display_name", "avatar_key", "coach_goal", "coach_context", "coach_model", "max_hr", "threshold_hr"] {
                    if let value = body?[key] { profileEdits[key] = value }
                }
                return ok(Data(#"{"ok":true,"hasAnthropicKey":\(hasKey),"anthropicKeyLast4":\(hasKey ? "\"mock\"" : "null")}"#.utf8))
            // W11 — the You tab.
            case ("GET", "/api/mutations-log"):
                return ok(unscrubbed(try Fixtures.data("mutations-log.json")))
            case ("GET", "/api/mcp-tokens"):
                return ok(try tokenList())
            case ("POST", "/api/mcp-tokens"):
                minted += 1
                let id = "mock-token-\(minted)"
                let token = "apx_mock_\(String(repeating: "0", count: 28))\(String(format: "%04d", minted))"
                mintedTokens.append([
                    "id": id, "name": body?["name"] as? String ?? "Token", "token_last4": String(token.suffix(4)),
                    "created_at": CompletionRows.isoTimestamp(clock.now), "last_used_at": NSNull(), "revoked_at": NSNull(),
                ])
                return ok(try JSONSerialization.data(withJSONObject: ["id": id, "token": token]))
            case ("DELETE", "/api/mcp-tokens"):
                let clientId = queryValue("client_id", in: query)
                if !clientId.isEmpty {
                    disconnectedApps.insert(clientId)
                    return ok(Data(#"{"ok":true,"revoked":1}"#.utf8))
                }
                revokedTokens.insert(queryValue("id", in: query))
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("DELETE", "/api/account"):
                return ok(Data(#"{"ok":true,"deleted":"ios-fixture-user"}"#.utf8))
            case ("POST", "/api/provider-sync"):
                return try providerSync(action: action, body: body)
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
                if body?["name"] as? String == "update_chart_draft" {
                    return ok(try reducedChartDraft(body))
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
            case ("PATCH", "/api/exercise-definitions"):
                return try patchDefinition(id: queryValue("id", in: query), fields: body?["fields"] as? [String: Any] ?? [:])
            case ("POST", "/api/query"):
                let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let tool = body?["tool"] as? String ?? "unknown"
                let args = body?["args"] as? [String: Any] ?? [:]
                switch tool {
                case "search_exercises": return ok(try searchExercises(args))
                case "get_exercise_history": return try exerciseHistory(args)
                case "get_training_blocks": return try trainingBlocks(args)
                case "get_meals": return ok(try mealsQuery(args))
                default: return ok(try Fixtures.data("query-\(tool).json"))
                }
            case ("GET", "/api/meal-favorites"):
                return ok(try JSONSerialization.data(withJSONObject: ["favorites": try currentFavorites()]))
            case ("POST", "/api/meal-favorites"):
                var favorite: [String: Any] = [:]
                for (column, value) in body ?? [:] { favorite[Self.camel(column)] = value }
                if favorite["notes"] == nil || favorite["notes"] is NSNull { favorite["notes"] = "" }
                let id = favorite["id"] as? String ?? ""
                edits.favorites[id] = favorite
                edits.deletedFavorites.remove(id)
                return ok(try JSONSerialization.data(withJSONObject: ["id": id]))
            case ("DELETE", "/api/meal-favorites"):
                let id = queryValue("id", in: query)
                edits.favorites[id] = nil
                edits.deletedFavorites.insert(id)
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("POST", "/api/meals"):
                var row = body ?? [:]
                row["triggered_by"] = nil
                if let problem = Self.mealProblem(row) { return HTTPResponse(status: 400, headers: [:], body: Data(problem.utf8)) }
                let id = row["id"] as? String ?? "meal-mock"
                edits.meals[id] = row
                return ok(try JSONSerialization.data(withJSONObject: ["id": id]))
            case ("PATCH", "/api/meals"):
                let id = queryValue("id", in: query)
                guard var meal = try currentMeals().first(where: { $0["id"] as? String == id }) else {
                    return HTTPResponse(status: 404, headers: [:], body: Data("Meal not found".utf8))
                }
                for (column, value) in body?["fields"] as? [String: Any] ?? [:] { meal[column] = value }
                if let problem = Self.mealProblem(meal) { return HTTPResponse(status: 400, headers: [:], body: Data(problem.utf8)) }
                edits.meals[id] = meal
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("DELETE", "/api/meals"):
                let id = queryValue("id", in: query)
                edits.meals[id] = nil
                edits.deletedMeals.insert(id)
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("POST", "/api/blocks") where queryValue("resource", in: query) == "cycle":
                return try cyclePreview(body?["spec"] as? [String: Any])
            case ("POST", "/api/blocks") where queryValue("batch", in: query) == "1":
                let rows = body?["rows"] as? [[String: Any]] ?? []
                let ids = try rows.map { try rememberBlock($0) }
                return ok(try JSONSerialization.data(withJSONObject: ["ids": ids]))
            case ("POST", "/api/blocks"):
                var row = body ?? [:]
                row["triggered_by"] = nil
                row["log"] = nil
                return ok(try JSONSerialization.data(withJSONObject: ["id": try rememberBlock(row)]))
            case ("PATCH", "/api/blocks"):
                let id = queryValue("id", in: query)
                guard var block = try currentBlocks().first(where: { $0["id"] as? String == id }) else {
                    return HTTPResponse(status: 404, headers: [:], body: Data("Block not found".utf8))
                }
                for (column, value) in body?["fields"] as? [String: Any] ?? [:] { block[column] = value }
                edits.blocks[id] = try decorated(block)
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("DELETE", "/api/blocks"):
                let id = queryValue("id", in: query)
                edits.blocks[id] = nil
                edits.deletedBlocks.insert(id)
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("POST", "/api/objectives"):
                let id = "mock-objective-\(edits.objectives.count + 1)"
                edits.objectives.append([
                    "id": id, "name": body?["name"] ?? "", "discipline": body?["discipline"] ?? NSNull(),
                    "target_date": body?["target_date"] ?? NSNull(), "status": body?["status"] ?? "active", "notes": body?["notes"] ?? "",
                ])
                return ok(try JSONSerialization.data(withJSONObject: ["id": id]))
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
            case ("GET", "/api/analytics-tiles"):
                return ok(try tilesBody())
            case ("POST", "/api/analytics-compute"):
                return ok(try computeBody(body))
            case ("POST", "/api/analytics-tiles"):
                return ok(try saveTile(body))
            case ("PATCH", "/api/analytics-tiles"):
                for entry in body?["layouts"] as? [[String: Any]] ?? [] {
                    if let id = entry["id"] as? String {
                        tileEdits.layouts[id] = ["x": entry["x"] ?? 0, "y": entry["y"] ?? 0, "w": entry["w"] ?? 12, "h": entry["h"] ?? 4]
                    }
                }
                return ok(Data(#"{"ok":true}"#.utf8))
            case ("DELETE", "/api/analytics-tiles"):
                let id = queryValue("id", in: query)
                guard try tilesList().contains(where: { $0["id"] as? String == id }) else {
                    return HTTPResponse(status: 404, headers: [:], body: Data("Tile not found".utf8))
                }
                tileEdits.deleted.insert(id)
                return ok(Data(#"{"id":"\(id)"}"#.utf8))
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
        if body?["withTools"] as? Bool == true {
            switch body?["mode"] as? String {
            case "builder": return try Fixtures.data("chat-stream-builder.ndjson")
            case "analytics": return try Fixtures.data("chat-stream-analytics.ndjson")
            default: return try Fixtures.data("chat-stream.ndjson")
            }
        }
        let messages = body?["messages"] as? [[String: Any]] ?? []
        let last = messages.last
        let text: String
        if let content = last?["content"] as? String, content == ChatCopy.notesPrompt {
            text = "**Today** — Fixture Push Day at 17:30.\n\n- Warm up the shoulders first\n- Last time you pressed 110 lb; aim for 115\n\nKeep the run easy tomorrow."
        } else if let blocks = last?["content"] as? [[String: Any]], blocks.contains(where: { $0["type"] as? String == "tool_result" }) {
            switch body?["mode"] as? String {
            case "builder": text = "Added Fixture Press, 3 × 8. Review the form and press Apply."
            case "analytics": text = "Set up weekly tonnage as bars. Review the form and press Save."
            default: text = "Done — Fixture Push Day on 2026-09-29 is cleared."
            }
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

    // MARK: - W11 reads and writes

    /// The fixture emitter scrubs secrets and volatile values to placeholders
    /// (`<timestamp>`, `<uuid>`, `<last4>`, `<token>`); the screens need
    /// parseable values, so the mock puts stand-ins back.
    private func unscrubbed(_ data: Data) -> Data {
        var text = String(decoding: data, as: UTF8.self)
        text = text.replacingOccurrences(of: "<timestamp>", with: CompletionRows.isoTimestamp(clock.now.addingTimeInterval(-3_600)))
        text = text.replacingOccurrences(of: "<uuid>", with: "00000000-0000-4000-8000-000000000001")
        text = text.replacingOccurrences(of: "<last4>", with: "k9x2")
        text = text.replacingOccurrences(of: "<token>", with: "apx_mock_token")
        return Data(text.utf8)
    }

    /// The You tab's PATCHes, reflected the way the handler would store them
    /// (trimmed; the model label resolved from the fixture's own catalog).
    private func withProfileEdits(_ data: Data) -> Data {
        guard !profileEdits.isEmpty, var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
        let camel: [String: String] = [
            "display_name": "displayName", "avatar_key": "avatarKey", "coach_goal": "coachGoal", "coach_context": "coachContext",
            "coach_model": "coachModel", "max_hr": "maxHr", "threshold_hr": "thresholdHr",
        ]
        for (key, value) in profileEdits {
            object[camel[key] ?? key] = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? value
        }
        if let model = profileEdits["coach_model"] {
            let catalog = object["coachModels"] as? [[String: Any]] ?? []
            let picked = catalog.first { $0["id"] as? String == model as? String } ?? catalog.first { $0["label"] as? String == "Opus 5" }
            object["coachModelLabel"] = picked?["label"] ?? object["coachModelLabel"] ?? NSNull()
        }
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }

    private func tokenList() throws -> Data {
        guard var object = (try JSONSerialization.jsonObject(with: unscrubbed(try Fixtures.data("mcp-tokens.json")))) as? [String: Any] else {
            return try Fixtures.data("mcp-tokens.json")
        }
        var tokens = (object["tokens"] as? [[String: Any]] ?? []) + mintedTokens
        tokens = tokens.map { token in
            guard let id = token["id"] as? String, revokedTokens.contains(id) else { return token }
            var revoked = token
            revoked["revoked_at"] = CompletionRows.isoTimestamp(clock.now)
            return revoked
        }
        object["tokens"] = tokens
        object["connections"] = (object["connections"] as? [[String: Any]] ?? []).filter { !disconnectedApps.contains($0["client_id"] as? String ?? "") }
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// `-apexMockCoros disconnected|expired` starts the connection in that
    /// state; the default is the fixture's (connected). `connect-start`
    /// answers with the callback itself on the app's scheme, so the smoke
    /// connects without a browser (`CorosModel.connect`).
    private func providerSync(action: String?, body: [String: Any]?) throws -> HTTPResponse {
        switch action {
        case "status":
            guard var object = (try JSONSerialization.jsonObject(with: unscrubbed(try Fixtures.data("provider-status.json")))) as? [String: Any],
                  var coros = object["coros"] as? [String: Any] else { return ok(try Fixtures.data("provider-status.json")) }
            coros["status"] = corosStatus
            coros["autoSync"] = corosAutoSync
            if corosStatus != "connected" { coros["lastSyncedAt"] = NSNull(); coros["connectedAt"] = NSNull() }
            if corosSynced { coros["pendingFillCount"] = 0; coros["lastSyncedAt"] = CompletionRows.isoTimestamp(clock.now) }
            object["coros"] = coros
            return ok(try JSONSerialization.data(withJSONObject: object))
        case "connect-start":
            corosStatus = "connected"
            return ok(Data(#"{"authorizeUrl":"apextraining://connected?provider=coros"}"#.utf8))
        case "disconnect":
            corosStatus = "disconnected"
            return ok(Data(#"{"ok":true}"#.utf8))
        case "set-auto-sync":
            corosAutoSync = body?["enabled"] as? Bool ?? true
            return ok(Data(#"{"ok":true,"autoSync":\(corosAutoSync)}"#.utf8))
        case "preview":
            guard corosStatus == "connected" else { return HTTPResponse(status: 409, headers: [:], body: Data("provider-expired".utf8)) }
            return ok(try Fixtures.data("provider-preview.json"))
        case "apply":
            corosSynced = true
            return ok(try Fixtures.data("provider-apply.json"))
        default:
            return HTTPResponse(status: 400, headers: [:], body: Data("unknown action".utf8))
        }
    }

    // MARK: - W9 analytics

    private func tilesFixture() throws -> [String: Any] {
        (try JSONSerialization.jsonObject(with: try Fixtures.data("analytics-tiles.json")) as? [String: Any]) ?? [:]
    }

    /// The fixture's tiles plus every save, minus every delete, with the
    /// layouts the edit mode committed — sorted the way the server sorts.
    private func tilesList() throws -> [[String: Any]] {
        var tiles = (try tilesFixture()["tiles"] as? [[String: Any]]) ?? []
        for (id, saved) in tileEdits.saved {
            if let index = tiles.firstIndex(where: { $0["id"] as? String == id }) { tiles[index] = saved } else { tiles.append(saved) }
        }
        tiles = tiles.filter { !tileEdits.deleted.contains($0["id"] as? String ?? "") }
        tiles = tiles.map { tile in
            guard let id = tile["id"] as? String, let layout = tileEdits.layouts[id] else { return tile }
            var moved = tile
            moved["layout"] = layout
            return moved
        }
        let position: ([String: Any]) -> (Int, Int) = { tile in
            let layout = tile["layout"] as? [String: Any]
            return (layout?["y"] as? Int ?? 0, layout?["x"] as? Int ?? 0)
        }
        return tiles.sorted { position($0) < position($1) }
    }

    private func tilesBody() throws -> Data {
        var object = try tilesFixture()
        object["tiles"] = try tilesList()
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// Compute answers by matching each spec (or draft) to a seeded tile and
    /// serving that tile's slot of `analytics-compute.json` — the fixture is
    /// index-aligned with `analytics-tiles.json` on purpose.
    private func computeBody(_ body: [String: Any]?) throws -> Data {
        let compute = (try JSONSerialization.jsonObject(with: try Fixtures.data("analytics-compute.json")) as? [String: Any]) ?? [:]
        let slots = compute["tiles"] as? [[String: Any]] ?? []
        let seeded = (try tilesFixture()["tiles"] as? [[String: Any]]) ?? []
        func slot(matching chartType: String?) -> [String: Any] {
            if let index = seeded.firstIndex(where: { ($0["draft"] as? [String: Any])?["chartType"] as? String == chartType }), index < slots.count {
                return slots[index]
            }
            return slots.count > 1 ? slots[1] : ["ok": false, "problem": "no fixture slot"]
        }
        var answers: [[String: Any]] = []
        if let specs = body?["specs"] as? [[String: Any]] {
            for spec in specs {
                if let index = seeded.firstIndex(where: { ($0["spec"] as? NSDictionary)?.isEqual(to: spec) == true }), index < slots.count {
                    answers.append(slots[index])
                } else {
                    answers.append(slot(matching: spec["chartType"] as? String))
                }
            }
        } else if let drafts = body?["drafts"] as? [[String: Any]] {
            let preview = (try JSONSerialization.jsonObject(with: try Fixtures.data("analytics-compute-preview.json")) as? [String: Any])?["tiles"] as? [[String: Any]] ?? []
            for draft in drafts {
                let series = draft["series"] as? [[String: Any]] ?? []
                if series.isEmpty || series.contains(where: { ($0["measure"] as? String ?? "").isEmpty }), let first = preview.first {
                    answers.append(first)
                } else {
                    answers.append(slot(matching: draft["chartType"] as? String))
                }
            }
        }
        return try JSONSerialization.data(withJSONObject: ["today": body?["today"] ?? "2026-09-08", "tiles": answers])
    }

    /// The native Save: the fixture's answer reshaped around the caller's
    /// id, draft and layout, then remembered for later reads.
    private func saveTile(_ body: [String: Any]?) throws -> Data {
        guard let draft = body?["draft"] as? [String: Any] else {
            // The web's spec body — accepted, not replayed.
            return Data(#"{"id":"\(body?["id"] as? String ?? "")"}"#.utf8)
        }
        let title = (draft["title"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else {
            return Data(#"{"ok":false,"problem":"Give the tile a title"}"#.utf8)
        }
        var object = (try JSONSerialization.jsonObject(with: try Fixtures.data("analytics-tiles-save.json")) as? [String: Any]) ?? [:]
        var tile = object["tile"] as? [String: Any] ?? [:]
        let id = body?["id"] as? String ?? "tile-mock"
        tile["id"] = id
        tile["title"] = title
        tile["draft"] = draft
        if var spec = tile["spec"] as? [String: Any] {
            spec["title"] = title
            spec["chartType"] = draft["chartType"] ?? spec["chartType"]
            tile["spec"] = spec
        }
        tile["layout"] = body?["layout"] ?? ["x": 0, "y": 0, "w": 12, "h": 4]
        object["id"] = id
        object["tile"] = tile
        tileEdits.saved[id] = tile
        return try JSONSerialization.data(withJSONObject: object)
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

    /// The chart-draft reduce (W9): the fixture's answer, with the caller's own
    /// title kept unless the input set one, so an edit stays on its tile.
    private func reducedChartDraft(_ body: [String: Any]?) throws -> Data {
        guard var object = (try JSONSerialization.jsonObject(with: try Fixtures.data("coach-tool-chart-draft.json"))) as? [String: Any],
              var draft = object["draft"] as? [String: Any] else { return try Fixtures.data("coach-tool-chart-draft.json") }
        if let sent = body?["draft"] as? [String: Any],
           let title = sent["title"] as? String, !title.isEmpty, (body?["input"] as? [String: Any])?["title"] == nil {
            draft["title"] = title
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
        if object["definitions"] is [[String: Any]] {
            object["definitions"] = (try? currentDefinitions()) ?? []
        }
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }

    // MARK: - W10 library

    /// The fixture's definitions plus every one the session added, with the
    /// session's PATCHes applied — what `/api/schedule` and `search_exercises`
    /// both answer from, so the list and the detail agree.
    private func currentDefinitions() throws -> [[String: Any]] {
        var definitions = (try scheduleObject()["definitions"] as? [[String: Any]]) ?? []
        definitions.append(contentsOf: edits.addedDefinitions)
        return definitions.map { definition in
            guard let id = definition["id"] as? String, let patch = edits.patchedDefinitions[id] else { return definition }
            return definition.merging(patch) { _, new in new }
        }
    }

    /// The editor's PATCH, reflected the way the handler stores it: only the
    /// sent columns, and a rename appends the old name as an alias
    /// (`api/_lib/services/definitions.ts`).
    private func patchDefinition(id: String, fields: [String: Any]) throws -> HTTPResponse {
        guard let current = try currentDefinitions().first(where: { $0["id"] as? String == id }) else {
            return HTTPResponse(status: 404, headers: [:], body: Data("Definition not found".utf8))
        }
        var patch = edits.patchedDefinitions[id] ?? [:]
        for (column, value) in fields {
            patch[Self.camel(column)] = value
        }
        if let newName = fields["canonical_name"] as? String, let oldName = current["canonicalName"] as? String, newName != oldName {
            var aliases = (fields["aliases"] as? [String]) ?? (current["aliases"] as? [String]) ?? []
            if !aliases.contains(oldName) { aliases.append(oldName) }
            patch["aliases"] = aliases.filter { $0 != newName }
        }
        edits.patchedDefinitions[id] = patch
        return ok(Data(#"{"ok":true}"#.utf8))
    }

    /// `search_exercises` over the current definitions: the fixture's stats
    /// (last performed, references) for the ones it knows, none for the rest.
    private func searchExercises(_ args: [String: Any]) throws -> Data {
        let fixture = (try JSONSerialization.jsonObject(with: try Fixtures.data("query-search_exercises.json"))) as? [String: Any] ?? [:]
        let known = ((fixture["result"] as? [String: Any])?["exercises"] as? [[String: Any]] ?? [])
            .reduce(into: [String: [String: Any]]()) { acc, entry in if let id = entry["id"] as? String { acc[id] = entry } }
        let includeArchived = args["include_archived"] as? Bool ?? false
        let includeReferences = args["include_references"] as? Bool ?? false
        let needle = (args["query"] as? String ?? "").lowercased()
        let entries: [[String: Any]] = try currentDefinitions().compactMap { definition in
            let id = definition["id"] as? String ?? ""
            let name = definition["canonicalName"] as? String ?? ""
            let aliases = definition["aliases"] as? [String] ?? []
            let archived = !(definition["archivedAt"] is NSNull) && definition["archivedAt"] != nil
            if archived && !includeArchived { return nil }
            if !needle.isEmpty, !name.lowercased().contains(needle), !aliases.contains(where: { $0.lowercased().contains(needle) }) { return nil }
            var entry: [String: Any] = [
                "id": id, "canonical_name": name, "category": definition["category"] ?? "strength", "aliases": aliases,
                "muscle_groups": definition["muscleGroups"] ?? [], "equipment": definition["equipment"] ?? [],
                "is_unilateral": definition["isUnilateral"] ?? false,
                "default_prescription": [
                    "sets": definition["defaultSets"] ?? NSNull(), "reps": definition["defaultReps"] ?? NSNull(),
                    "duration": definition["defaultDuration"] ?? NSNull(), "weight": definition["defaultWeight"] ?? NSNull(),
                    "rest": definition["defaultRest"] ?? NSNull(),
                ],
                "technique_notes": definition["techniqueNotes"] ?? NSNull(),
                "last_performed": known[id]?["last_performed"] ?? NSNull(),
                "archived": archived,
            ]
            if includeReferences { entry["references"] = known[id]?["references"] ?? 0 }
            return entry
        }
        let result: [String: Any] = ["query": needle.isEmpty ? NSNull() : needle, "total_matches": entries.count, "exercises": entries]
        return try JSONSerialization.data(withJSONObject: ["tool": "search_exercises", "result": result])
    }

    // MARK: - W10 blocks

    private static let mockToday = "2026-09-08"

    private func blocksListFixture() throws -> [String: Any] {
        ((try JSONSerialization.jsonObject(with: try Fixtures.data("query-get_training_blocks.json"))) as? [String: Any])?["result"] as? [String: Any] ?? [:]
    }

    /// The fixture's blocks plus the session's, minus the deleted, oldest first.
    private func currentBlocks() throws -> [[String: Any]] {
        var blocks = (try blocksListFixture()["blocks"] as? [[String: Any]]) ?? []
        blocks = blocks.filter { !edits.deletedBlocks.contains($0["id"] as? String ?? "") }
            .map { block in
                guard let id = block["id"] as? String, let patched = edits.blocks[id] else { return block }
                return patched
            }
        for (id, block) in edits.blocks where !blocks.contains(where: { $0["id"] as? String == id }) { blocks.append(block) }
        return blocks.sorted { ($0["start_date"] as? String ?? "") < ($1["start_date"] as? String ?? "") }
    }

    private func currentObjectives() throws -> [[String: Any]] {
        ((try blocksListFixture()["objectives"] as? [[String: Any]]) ?? []) + edits.objectives
    }

    /// The tool's `weeks`, `current_week` and nested `objective` for a row the
    /// session wrote — scaffolding for the mock, never app logic.
    private func decorated(_ row: [String: Any]) throws -> [String: Any] {
        var block = row
        let start = DayKey(row["start_date"] as? String ?? "") ?? DayKey(Self.mockToday)!
        let end = DayKey(row["end_date_exclusive"] as? String ?? "") ?? start.adding(days: 7)
        let weeks = max(1, start.days(until: end) / 7)
        block["weeks"] = weeks
        let today = DayKey(Self.mockToday)!
        block["current_week"] = (start <= today && today < end) ? start.days(until: today) / 7 + 1 : NSNull()
        if block["intent"] == nil { block["intent"] = "" }
        if block["phase"] == nil { block["phase"] = NSNull() }
        if block["weekly_targets"] == nil { block["weekly_targets"] = [String: Any]() }
        let objectiveId = row["objective_id"] as? String
        block["objective_id"] = objectiveId ?? NSNull()
        block["objective"] = try currentObjectives().first { $0["id"] as? String == objectiveId } ?? NSNull()
        return block
    }

    private func rememberBlock(_ row: [String: Any]) throws -> String {
        let id = "mock-block-\(edits.blocks.count + edits.deletedBlocks.count + 1)"
        var block = row
        block["id"] = id
        edits.blocks[id] = try decorated(block)
        return id
    }

    /// `get_training_blocks`: the list with the session's writes, `current`
    /// recomputed for the fixed clock; `block_id` answers the detail fixture's
    /// progress under the requested block's summary.
    private func trainingBlocks(_ args: [String: Any]) throws -> HTTPResponse {
        let blocks = try currentBlocks()
        let today = DayKey(Self.mockToday)!
        let current = blocks.first { block in
            guard let s = DayKey(block["start_date"] as? String ?? ""), let e = DayKey(block["end_date_exclusive"] as? String ?? "") else { return false }
            return s <= today && today < e
        }
        var result: [String: Any] = ["today": Self.mockToday, "current": current.map { var c = $0; c["progress"] = NSNull(); return c } ?? NSNull()]
        if let blockId = args["block_id"] as? String {
            guard var block = blocks.first(where: { $0["id"] as? String == blockId }) else {
                return HTTPResponse(status: 400, headers: [:], body: Data("block_id does not name one of your blocks.".utf8))
            }
            let detail = ((try JSONSerialization.jsonObject(with: try Fixtures.data("query-get_training_blocks-detail.json"))) as? [String: Any])?["result"] as? [String: Any]
            block["progress"] = (detail?["block"] as? [String: Any])?["progress"] ?? NSNull()
            result["block"] = block
        } else {
            if args["scope"] as? String == "all" { result["blocks"] = blocks }
            if args["include_objectives"] as? Bool == true { result["objectives"] = try currentObjectives() }
        }
        return ok(try JSONSerialization.data(withJSONObject: ["tool": "get_training_blocks", "result": result]))
    }

    /// The cycle preview by its spec: the generator's refusal for a blank
    /// name, the conflict fixture for a start inside the seeded base block,
    /// else the ok fixture re-prefixed with the caller's name.
    private func cyclePreview(_ spec: [String: Any]?) throws -> HTTPResponse {
        guard let spec else { return HTTPResponse(status: 400, headers: [:], body: Data("spec must be an object".utf8)) }
        let prefix = (spec["namePrefix"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if prefix.isEmpty { return ok(try Fixtures.data("blocks-cycle-problem.json")) }
        let start = spec["startDate"] as? String ?? ""
        if start < "2026-09-28" { return ok(try Fixtures.data("blocks-cycle-conflict.json")) }
        guard var object = (try JSONSerialization.jsonObject(with: try Fixtures.data("blocks-cycle.json"))) as? [String: Any] else {
            return ok(try Fixtures.data("blocks-cycle.json"))
        }
        let rename: ([String: Any], String) -> [String: Any] = { block, key in
            var next = block
            if let name = block[key] as? String { next[key] = name.replacingOccurrences(of: "Fixture Cycle", with: prefix) }
            return next
        }
        object["blocks"] = (object["blocks"] as? [[String: Any]] ?? []).map { rename($0, "name") }
        object["rows"] = (object["rows"] as? [[String: Any]] ?? []).map { rename($0, "name") }
        return ok(try JSONSerialization.data(withJSONObject: object))
    }

    // MARK: - W10 meals

    private static let macroLabels: [(column: String, label: String)] = [
        ("calories", "Calories"), ("protein_g", "Protein"), ("carbs_g", "Carbs"), ("fiber_g", "Fiber"), ("sugar_g", "Sugar"),
        ("fat_total_g", "Total fat"), ("fat_saturated_g", "Saturated fat"), ("fat_trans_g", "Trans fat"), ("alcohol_g", "Alcohol"),
    ]

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        return (value as? NSNumber)?.doubleValue
    }

    /// `api/_lib/services/meals.ts`: every macro a number ≥ 0, the fat total
    /// never below saturated + trans — with the composer's own sentences.
    private static func mealProblem(_ row: [String: Any]) -> String? {
        for field in macroLabels {
            guard let value = row[field.column], !(value is NSNull) else { continue }
            guard let n = number(value), n.isFinite, n >= 0 else { return "\(field.label) must be a number of at least 0" }
        }
        if let total = number(row["fat_total_g"]), total < (number(row["fat_saturated_g"]) ?? 0) + (number(row["fat_trans_g"]) ?? 0) {
            return "Total fat can't be less than saturated + trans"
        }
        return nil
    }

    /// The fixture's meals (each with its day) plus the session's, minus the deleted.
    private func currentMeals() throws -> [[String: Any]] {
        let fixture = ((try JSONSerialization.jsonObject(with: try Fixtures.data("query-get_meals.json"))) as? [String: Any])?["result"] as? [String: Any]
        var rows: [[String: Any]] = []
        for day in fixture?["days"] as? [[String: Any]] ?? [] {
            for var meal in day["meals"] as? [[String: Any]] ?? [] {
                meal["date"] = day["date"]
                rows.append(meal)
            }
        }
        rows = rows.filter { !edits.deletedMeals.contains($0["id"] as? String ?? "") }
            .map { meal in
                guard let id = meal["id"] as? String, let patched = edits.meals[id] else { return meal }
                return patched
            }
        for (id, meal) in edits.meals where !rows.contains(where: { $0["id"] as? String == id }) { rows.append(meal) }
        return rows
    }

    private func currentFavorites() throws -> [[String: Any]] {
        let fixture = ((try JSONSerialization.jsonObject(with: try Fixtures.data("meal-favorites.json"))) as? [String: Any])?["favorites"] as? [[String: Any]] ?? []
        var favorites = fixture.filter { !edits.deletedFavorites.contains($0["id"] as? String ?? "") }
            .map { favorite in
                guard let id = favorite["id"] as? String, let saved = edits.favorites[id] else { return favorite }
                return saved
            }
        for (id, favorite) in edits.favorites where !favorites.contains(where: { $0["id"] as? String == id }) { favorites.append(favorite) }
        return favorites.sorted { ($0["title"] as? String ?? "") < ($1["title"] as? String ?? "") }
    }

    /// `get_meals` over the current meals: per-day totals summed the way the
    /// tool sums them (stored calories, else Atwater 4/4/9/7; tenth-gram macros).
    private func mealsQuery(_ args: [String: Any]) throws -> Data {
        let start = args["start_date"] as? String ?? ""
        let end = args["end_date"] as? String ?? "9999"
        let includeItems = args["include_items"] as? Bool ?? false
        var byDate: [String: [[String: Any]]] = [:]
        for meal in try currentMeals() {
            guard let date = meal["date"] as? String, date >= start, date <= end else { continue }
            byDate[date, default: []].append(meal)
        }
        let tenth: (Double) -> Double = { ($0 * 10).rounded() / 10 }
        let days: [[String: Any]] = byDate.keys.sorted().map { date in
            let meals = byDate[date]!.sorted { (TimeLabel.minutes($0["time"] as? String ?? "") ?? 0) < (TimeLabel.minutes($1["time"] as? String ?? "") ?? 0) }
            var calories = 0.0, protein = 0.0, carbs = 0.0, fat = 0.0
            let items: [[String: Any]] = meals.map { meal in
                let p = Self.number(meal["protein_g"]), c = Self.number(meal["carbs_g"]), f = Self.number(meal["fat_total_g"]), a = Self.number(meal["alcohol_g"])
                let derived = Nutrition.derivedCalories(proteinG: p, carbsG: c, fatTotalG: f, alcoholG: a).map(Double.init)
                let kcal = Self.number(meal["calories"]) ?? derived
                calories += kcal ?? 0
                protein += p ?? 0
                carbs += c ?? 0
                fat += f ?? 0
                var item: [String: Any] = [:]
                for key in ["id", "title", "time", "meal_type", "protein_g", "carbs_g", "fiber_g", "sugar_g", "fat_total_g", "fat_saturated_g", "fat_trans_g", "alcohol_g"] {
                    item[key] = meal[key] ?? NSNull()
                }
                item["calories"] = kcal ?? NSNull()
                item["notes"] = (meal["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
                return item
            }
            var day: [String: Any] = [
                "date": date, "meal_count": meals.count,
                "totals": ["calories": calories.rounded(), "proteinG": tenth(protein), "carbsG": tenth(carbs), "fatTotalG": tenth(fat)],
            ]
            if includeItems { day["meals"] = items }
            return day
        }
        let result: [String: Any] = ["start_date": start, "end_date": end, "days": days]
        return try JSONSerialization.data(withJSONObject: ["tool": "get_meals", "result": result])
    }

    /// The fixture's history for Fixture Press by any of its current
    /// spellings (a rename keeps the old one as an alias); the tool's own 400
    /// for anything else, which the detail reads as "no logged history".
    private func exerciseHistory(_ args: [String: Any]) throws -> HTTPResponse {
        let asked = (args["exercise_name"] as? String ?? "").lowercased()
        let press = try currentDefinitions().first { $0["id"] as? String == "ios-fixture-def" }
        var spellings = ["fixture press", "fx press"]
        if let name = press?["canonicalName"] as? String { spellings.append(name.lowercased()) }
        spellings.append(contentsOf: (press?["aliases"] as? [String] ?? []).map { $0.lowercased() })
        guard spellings.contains(asked) else {
            return HTTPResponse(status: 400, headers: [:], body: Data("No logged history for \"\(args["exercise_name"] ?? "")\". Use search_exercises to find the right name.".utf8))
        }
        return ok(try Fixtures.data("query-get_exercise_history.json"))
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
