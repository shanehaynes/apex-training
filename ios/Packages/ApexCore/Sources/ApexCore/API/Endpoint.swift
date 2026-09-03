import Foundation

/// The `/api/*` surface the app reads and writes. Dates are always `YYYY-MM-DD`
/// strings — the API speaks strings, and converting to `Date` here would invent
/// a time zone the server never meant (architecture.md §5).
public struct Endpoint: Sendable, Equatable {
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    public let method: Method
    public let path: String
    public let query: [URLQueryItem]
    public let body: Data?

    public init(method: Method = .get, path: String, query: [URLQueryItem] = [], body: Data? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
    }

    public func url(relativeTo base: URL) -> URL? {
        guard var components = URLComponents(
            url: base.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else { return nil }
        if !query.isEmpty { components.queryItems = query }
        return components.url
    }

    // MARK: - W0 read endpoints

    /// One window of schedule: bases, expanded occurrences, and whichever
    /// side tables the caller asks for.
    public static func schedule(
        start: String,
        end: String,
        include: [String] = []
    ) -> Endpoint {
        var query = [URLQueryItem(name: "start", value: start), URLQueryItem(name: "end", value: end)]
        if !include.isEmpty {
            query.append(URLQueryItem(name: "include", value: include.joined(separator: ",")))
        }
        return Endpoint(path: "api/schedule", query: query)
    }

    /// The read-only coach tools, callable directly by the app.
    public static func query(tool: String, arguments: [String: String] = [:]) -> Endpoint {
        var query = [URLQueryItem(name: "tool", value: tool)]
        query.append(contentsOf: arguments.keys.sorted().map { URLQueryItem(name: $0, value: arguments[$0]) })
        return Endpoint(path: "api/query", query: query)
    }

    public static let profile = Endpoint(path: "api/profile")
}
