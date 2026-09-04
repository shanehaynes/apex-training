import Foundation

/// Every URL the app is asked to open (architecture.md §3): the custom scheme
/// `apextraining://…` and universal links on the web origin. Parsing is pure
/// so a Linux `swift test` proves it; the app decides what to do with each.
///
/// Two auth shapes, and they are handled differently downstream:
/// - `?code=` is the PKCE flow supabase-swift initiated itself (password
///   recovery from the app) → `AuthClient.session(from:)`.
/// - `#access_token=…&refresh_token=…&type=invite` is an implicit-flow link
///   the web handed over (D-020). A PKCE-configured client refuses it in
///   `session(from:)`, so the tokens go through `setSession` instead.
public enum DeepLink: Equatable, Sendable {
    case authCode(String)
    case authTokens(accessToken: String, refreshToken: String, type: AuthLinkType?)
    case authError(AuthLinkError)
    case connected(provider: String)
    case connectError(provider: String?, message: String?)
    case event(id: String, date: String)
    case library(definitionId: String)

    public enum AuthLinkType: String, Sendable, Equatable {
        case invite, recovery, signup, magiclink
        case emailChange = "email_change"

        /// Links that land needing a password set.
        public var needsPassword: Bool { self == .invite || self == .recovery }
    }

    public static let universalHost = "apextrainingcalendar.vercel.app"
    public static let scheme = "apextraining"

    /// nil for anything that is not ours.
    public static func parse(_ url: URL) -> DeepLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased() else { return nil }
        let host = components.host?.lowercased() ?? ""
        let path = components.path

        if scheme == DeepLink.scheme {
            switch host {
            case "auth": return parseAuth(components)
            case "connected":
                return .connected(provider: value("provider", in: components.queryItems) ?? "")
            case "connect_error":
                return .connectError(
                    provider: value("provider", in: components.queryItems),
                    message: value("message", in: components.queryItems) ?? value("error", in: components.queryItems)
                )
            default: return nil
            }
        }

        guard scheme == "https", host == universalHost else { return nil }
        let segments = path.split(separator: "/").map(String.init)
        switch segments.first {
        case "auth" where segments == ["auth", "callback"]:
            return parseAuth(components)
        case "app":
            if segments.count == 4, segments[1] == "event" { return .event(id: segments[2], date: segments[3]) }
            if segments.count == 3, segments[1] == "library" { return .library(definitionId: segments[2]) }
            return nil
        default:
            return nil
        }
    }

    private static func parseAuth(_ components: URLComponents) -> DeepLink? {
        if let error = AuthLinkError.parse(fragment: components.fragment, query: components.query) {
            return .authError(error)
        }
        let query = components.queryItems ?? []
        let fragment = FormQuery.items(components.fragment)
        if let code = value("code", in: query) ?? value("code", in: fragment) {
            return .authCode(code)
        }
        let type = (value("type", in: fragment) ?? value("type", in: query)).flatMap(AuthLinkType.init(rawValue:))
        if let access = value("access_token", in: fragment) ?? value("access_token", in: query) {
            guard let refresh = value("refresh_token", in: fragment) ?? value("refresh_token", in: query) else {
                return .authError(AuthLinkError(code: nil, message: "That sign-in link was incomplete. Ask for a fresh one."))
            }
            return .authTokens(accessToken: access, refreshToken: refresh, type: type)
        }
        return nil
    }

    private static func value(_ name: String, in items: [URLQueryItem]?) -> String? {
        items?.first { $0.name == name }?.value
    }
}

/// A refusal carried back from GoTrue on an invite or recovery link — a port
/// of `src/lib/auth/linkError.ts`; its test vectors run in `DeepLinkTests`.
public struct AuthLinkError: Equatable, Sendable {
    /// GoTrue's machine-readable code, e.g. `otp_expired`. Absent on old links.
    public let code: String?
    /// What the visitor is shown.
    public let message: String

    public init(code: String?, message: String) {
        self.code = code
        self.message = message
    }

    public static let expiredMessage = "That invite or reset link has expired, or it has already been used. "
        + "Ask for a fresh invite — or, if you already set a password, sign in below."

    /// Reads the fragment first (the implicit flow), then the query string
    /// (where a PKCE-configured project puts the same fields).
    public static func parse(fragment: String?, query: String?) -> AuthLinkError? {
        read(FormQuery.items(fragment)) ?? read(FormQuery.items(query))
    }

    private static func read(_ items: [URLQueryItem]) -> AuthLinkError? {
        func get(_ n: String) -> String? { items.first { $0.name == n }?.value }
        let code = get("error_code"), description = get("error_description"), error = get("error")
        if code == nil, description == nil, error == nil { return nil }
        if isSpentLink(code: code, description: description) { return AuthLinkError(code: code, message: expiredMessage) }
        if let description, !description.isEmpty { return AuthLinkError(code: code, message: description) }
        return AuthLinkError(code: code, message: "Sign-in link failed: \(error ?? "")")
    }

    private static func isSpentLink(code: String?, description: String?) -> Bool {
        if code == "otp_expired" { return true }
        guard code == nil, let description else { return false }
        return description.range(of: "expired|invalid", options: [.regularExpression, .caseInsensitive]) != nil
    }
}

/// `application/x-www-form-urlencoded` parsing the way `URLSearchParams` does
/// it: `+` is a space, which `URLComponents` alone gets wrong.
enum FormQuery {
    static func items(_ raw: String?) -> [URLQueryItem] {
        guard var raw, !raw.isEmpty else { return [] }
        if raw.hasPrefix("#") || raw.hasPrefix("?") { raw.removeFirst() }
        return raw.split(separator: "&", omittingEmptySubsequences: true).map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = decode(String(parts[0]))
            let value = parts.count > 1 ? decode(String(parts[1])) : ""
            return URLQueryItem(name: name, value: value)
        }
    }

    private static func decode(_ s: String) -> String {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? s
    }
}
