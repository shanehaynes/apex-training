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
struct MockEnvironment {
    /// 2026-09-08T12:00:00Z — the day the fixtures put four events on.
    let clock: any ApexClock = TestClock(now: Date(timeIntervalSince1970: 1_788_868_800))
    let cache: any CacheStore = MemoryCacheStore()
    let tokens: any TokenProvider = StaticTokenProvider()
    let transport: FixtureTransport
    let streams: FixtureStreams

    init() {
        let failing = Self.argument("-apexMockFail")
        transport = FixtureTransport(failingRoute: failing)
        streams = FixtureStreams()
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
    private(set) var requests: [(method: String, path: String, body: Data?)] = []
    private var completions: [String: (isCompleted: Bool, completedAt: String?)] = [:]

    init(failingRoute: String?) {
        self.failingRoute = failingRoute
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let query = request.url?.query ?? ""
        requests.append((method, path, request.httpBody))
        // The real thing takes a moment; so does this, so loading states render.
        try? await Task.sleep(for: .milliseconds(120))

        if let failingRoute, path.hasSuffix(failingRoute) {
            return HTTPResponse(status: 500, headers: [:], body: Data("mock failure".utf8))
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
                let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if body?["action"] as? String == "bootstrap" { return ok(try Fixtures.data("bootstrap.json")) }
                return ok(Data(#"{"ok":true}"#.utf8))
            default:
                return HTTPResponse(status: 404, headers: [:], body: Data("no fixture for \(method) \(path)".utf8))
            }
        } catch {
            return HTTPResponse(status: 404, headers: [:], body: Data(String(describing: error).utf8))
        }
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
