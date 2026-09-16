import ApexCore
import ApexFeatures
import Foundation

/// A scripted `HTTPTransport` for the You tab: answers by `METHOD /path`, with
/// `POST /api/provider-sync` split by its `action` ("POST /api/provider-sync
/// preview"), records every request's decoded body, and puts real values back
/// where the fixture emitter scrubbed them (`<timestamp>` and friends), the
/// way the app's mock does.
final class YouTransport: HTTPTransport, @unchecked Sendable {
    struct Recorded { let method: String; let path: String; let body: [String: Any]?; let query: String }
    enum Answer {
        case json(Int, Data)
        case fail
    }

    private let lock = NSLock()
    private var routes: [String: Answer] = [:]
    private(set) var requests: [Recorded] = []

    static func fixture(_ name: String) -> Data {
        var text = String(decoding: CoachTransport.fixture(name), as: UTF8.self)
        text = text.replacingOccurrences(of: "<timestamp>", with: "2026-09-08T11:00:00.000Z")
        text = text.replacingOccurrences(of: "<uuid>", with: "00000000-0000-4000-8000-000000000001")
        text = text.replacingOccurrences(of: "<last4>", with: "k9x2")
        text = text.replacingOccurrences(of: "<token>", with: "apx_test_token")
        return Data(text.utf8)
    }

    /// Every W11 route answered from its fixture; the profile as the fixture
    /// has it (no key) with a name and a goal for the screens to show.
    static func healthy(hasKey: Bool = false, corosStatus: String = "connected") -> YouTransport {
        let t = YouTransport()
        var profile = try! JSONSerialization.jsonObject(with: fixture("profile.json")) as! [String: Any]
        profile["hasAnthropicKey"] = hasKey
        profile["anthropicKeyLast4"] = hasKey ? "abcd" : NSNull()
        profile["displayName"] = "Shane"
        profile["coachGoal"] = "Run a sub-3-hour marathon"
        profile["thresholdHr"] = 165
        profile["maxHr"] = 188
        t.set("GET /api/profile", .json(200, try! JSONSerialization.data(withJSONObject: profile)))
        t.set("PATCH /api/profile", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("GET /api/mutations-log", .json(200, fixture("mutations-log.json")))
        t.set("GET /api/mcp-tokens", .json(200, fixture("mcp-tokens.json")))
        t.set("POST /api/mcp-tokens", .json(200, fixture("mcp-token-mint.json")))
        t.set("DELETE /api/mcp-tokens", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("DELETE /api/account", .json(200, Data(#"{"ok":true,"deleted":"u"}"#.utf8)))
        var status = try! JSONSerialization.jsonObject(with: fixture("provider-status.json")) as! [String: Any]
        var coros = status["coros"] as! [String: Any]
        coros["status"] = corosStatus
        status["coros"] = coros
        t.set("POST /api/provider-sync status", .json(200, try! JSONSerialization.data(withJSONObject: status)))
        t.set("POST /api/provider-sync connect-start", .json(200, Data(#"{"authorizeUrl":"apextraining://connected?provider=coros"}"#.utf8)))
        t.set("POST /api/provider-sync disconnect", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("POST /api/provider-sync set-auto-sync", .json(200, Data(#"{"ok":true,"autoSync":false}"#.utf8)))
        t.set("POST /api/provider-sync preview", .json(200, fixture("provider-preview.json")))
        t.set("POST /api/provider-sync apply", .json(200, fixture("provider-apply.json")))
        return t
    }

    func set(_ key: String, _ answer: Answer) { lock.withLock { routes[key] = answer } }
    func set(_ key: String, status: Int, body: String = "") { set(key, .json(status, Data(body.utf8))) }

    func requests(_ path: String, action: String? = nil) -> [Recorded] {
        lock.withLock { requests.filter { $0.path == path && (action == nil || $0.body?["action"] as? String == action) } }
    }

    /// The `/api/query` calls for one tool.
    func queries(tool: String) -> [Recorded] {
        lock.withLock { requests.filter { $0.path == "/api/query" && $0.body?["tool"] as? String == tool } }
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let path = request.url?.path ?? ""
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let method = request.httpMethod ?? "GET"
        let answer: Answer? = lock.withLock {
            requests.append(Recorded(method: method, path: path, body: body, query: request.url?.query ?? ""))
            if let action = body?["action"] as? String, let keyed = routes["\(method) \(path) \(action)"] { return keyed }
            // `POST /api/query` is one path for every tool (W10 keys the library's).
            if let tool = body?["tool"] as? String, let keyed = routes["\(method) \(path) \(tool)"] { return keyed }
            return routes["\(method) \(path)"]
        }
        switch answer {
        case .json(let status, let data)?: return HTTPResponse(status: status, headers: [:], body: data)
        case .fail?, nil: throw URLError(.notConnectedToInternet)
        }
    }

    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        HTTPStreamResponse(try await send(request))
    }
}

@MainActor
func makeYouModel(_ transport: YouTransport, email: String? = "agent@apex.local") -> YouModel {
    let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
    return YouModel(services: YouServices(
        client: client, publicOrigin: URL(string: "https://apextrainingcalendar.vercel.app")!, email: email,
        timeZone: TimeZone(identifier: "UTC")!, clock: TestClock(now: coachTestNow), versionLabel: "0.6.0 (312)"
    ))
}
