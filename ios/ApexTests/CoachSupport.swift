import ApexCore
import Foundation
import ApexFeatures

/// A scripted `HTTPTransport` for the coach: answers by `METHOD /path`, with
/// `POST /api/chat` split by `withTools`, streams NDJSON line by line, and can
/// hold a stream open for the Stop tests.
final class CoachTransport: HTTPTransport, @unchecked Sendable {
    struct Recorded: Equatable { let method: String; let path: String; let body: [String: Any]?
        static func == (a: Recorded, b: Recorded) -> Bool { a.method == b.method && a.path == b.path }
    }
    enum Answer {
        case json(Int, Data)
        case ndjson([String], holdOpen: Bool = false)
    }

    private let lock = NSLock()
    private var routes: [String: Answer] = [:]
    private(set) var requests: [Recorded] = []
    private var open: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private(set) var cancellations = 0

    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    static func fixture(_ name: String) -> Data { try! Data(contentsOf: fixtures.appendingPathComponent(name)) }
    static func fixtureLines(_ name: String) -> [String] {
        String(decoding: fixture(name), as: UTF8.self).split(separator: "\n").map(String.init)
    }
    static func text(_ deltas: String...) -> [String] {
        deltas.map { #"{"type":"text","delta":"\#($0)"}"# } + [#"{"type":"done"}"#]
    }
    static func profile(hasKey: Bool, model: String? = nil) -> Data {
        var object = try! JSONSerialization.jsonObject(with: fixture("profile.json")) as! [String: Any]
        object["hasAnthropicKey"] = hasKey
        object["anthropicKeyLast4"] = hasKey ? "abcd" : NSNull()
        object["coachModel"] = model ?? NSNull()
        object["coachModelLabel"] = model == "claude-sonnet-5" ? "Sonnet 5" : "Opus 4.8"
        return try! JSONSerialization.data(withJSONObject: object)
    }

    /// The happy path: a key, the recorded tool_use stream, a successful tool, a text follow-up.
    static func healthy(hasKey: Bool = true) -> CoachTransport {
        let t = CoachTransport()
        t.set("GET /api/profile", .json(200, profile(hasKey: hasKey)))
        t.set("POST /api/chat tools", .ndjson(fixtureLines("chat-stream.ndjson")))
        t.set("POST /api/chat", .ndjson(text("Done — ", "cleared.")))
        t.set("POST /api/coach-tool", .json(200, fixture("coach-tool.json")))
        t.set("PATCH /api/profile", .json(200, Data(#"{"ok":true,"hasAnthropicKey":true,"anthropicKeyLast4":"wxyz"}"#.utf8)))
        return t
    }

    func set(_ key: String, _ answer: Answer) { lock.withLock { routes[key] = answer } }
    func set(_ key: String, status: Int, body: String = "") { set(key, .json(status, Data(body.utf8))) }

    /// Finish every held-open stream.
    func release() {
        let held = lock.withLock { let h = open; open = []; return h }
        for c in held { c.finish() }
    }

    func requests(_ path: String) -> [Recorded] { lock.withLock { requests.filter { $0.path == path } } }

    private func answer(for request: URLRequest) -> Answer? {
        let path = request.url?.path ?? ""
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let method = request.httpMethod ?? "GET"
        return lock.withLock {
            requests.append(Recorded(method: method, path: path, body: body))
            if path == "/api/chat", body?["withTools"] as? Bool == true, let tools = routes["POST /api/chat tools"] { return tools }
            return routes["\(method) \(path)"]
        }
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        guard let answer = answer(for: request) else { throw URLError(.notConnectedToInternet) }
        switch answer {
        case .json(let status, let data): return HTTPResponse(status: status, headers: [:], body: data)
        case .ndjson(let lines, _): return HTTPResponse(status: 200, headers: [:], body: Data(lines.joined(separator: "\n").utf8))
        }
    }

    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        guard let answer = answer(for: request) else { throw URLError(.notConnectedToInternet) }
        switch answer {
        case .json(let status, let data):
            return HTTPStreamResponse(HTTPResponse(status: status, headers: [:], body: data))
        case .ndjson(let lines, let holdOpen):
            let (bytes, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            for line in lines { continuation.yield(Data((line + "\n").utf8)) }
            if holdOpen {
                lock.withLock { open.append(continuation) }
                continuation.onTermination = { [weak self] termination in
                    if case .cancelled = termination { self?.lock.withLock { self?.cancellations += 1 } }
                }
            } else {
                continuation.finish()
            }
            return HTTPStreamResponse(status: 200, headers: [:], bytes: bytes)
        }
    }
}

struct CoachTestTokens: TokenProvider {
    func accessToken() async throws -> String { "t" }
    func refresh() async throws -> String { "t" }
    func signOut() async {}
}

/// 2026-09-08T12:00:00Z — the fixture day.
let coachTestNow = Date(timeIntervalSince1970: 1_788_868_800)

@MainActor
func makeCoachModel(
    _ transport: CoachTransport, store: MemoryConversationStore = MemoryConversationStore(),
    clock: TestClock = TestClock(now: coachTestNow), onMutation: @escaping @MainActor @Sendable () -> Void = {}
) -> CoachModel {
    let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
    return CoachModel(services: CoachServices(
        client: client, store: store, clock: clock, timeZone: TimeZone(identifier: "UTC")!, onMutationConfirmed: onMutation
    ))
}

/// Polls for a main-actor condition — the model's actions are fire-and-forget tasks.
@MainActor
func waitFor(_ condition: @escaping @MainActor () -> Bool, timeout: Double = 3) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return condition()
}
