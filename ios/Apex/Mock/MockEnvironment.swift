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
        transport = FixtureTransport(failingRoute: failing, failOnce: failOnce, clock: clock)
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

    init(failingRoute: String?, failOnce: (route: String, count: Int)? = nil, clock: any ApexClock) {
        self.failingRoute = failingRoute
        self.failOnce = failOnce
        self.clock = clock
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
                return ok(applyCompletions(to: try Fixtures.data(start >= "2026-10-28" ? "schedule-empty.json" : "schedule.json")))
            case ("GET", "/api/profile"):
                return ok(try Fixtures.data("profile.json"))
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
