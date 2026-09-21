import ApexCore
import Foundation

/// Build configuration, read from the Info.plist keys that the xcconfig files
/// fill in (D-022). Reading them at runtime rather than baking them into Swift
/// means a built app can be inspected to see what it points at.
enum AppConfig {
    static let apiBase = url("APEX_API_BASE")
    static let supabaseURL = url("SUPABASE_URL")
    static let supabaseAnonKey = string("SUPABASE_ANON_KEY")
    static let name = string("APEX_CONFIGURATION")
    /// The web app's origin, for what the You tab points outside the app at:
    /// the MCP endpoint and the legal pages. The API base is the same origin
    /// (the Local configuration's vite server proxies `/api/*`), and a build
    /// can be inspected for it the same way.
    static let publicOrigin: URL = {
        var components = URLComponents(url: apiBase, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        return components?.url ?? apiBase
    }()
    /// The sign-in screen's "Request an invite" destination (W13); nil when the
    /// configuration sets none, in which case the screen states invite-only
    /// without a link.
    static let inviteContactURL: URL? = {
        let raw = string("APEX_INVITE_CONTACT")
        return raw.isEmpty ? nil : URL(string: raw)
    }()
    /// "0.6.0 (312)" — the About screen's line.
    static let versionLabel: String = {
        build.isEmpty ? shortVersion : "\(shortVersion) (\(build))"
    }()

    /// `ios/0.6.0+312` — the `X-Apex-Client` every request carries (G8), so a
    /// server log can say which build produced the traffic.
    static let clientTag: String = ClientTag.ios(version: shortVersion, build: build)

    /// `CFBundleVersion` as the integer `/api/version`'s `minBuild` is compared
    /// against; 0 when it is not a plain integer, which never blocks.
    static let buildNumber: Int = ClientTag.buildNumber(build)

    /// Where the update screen sends someone whose build the server has
    /// retired; nil while there is no App Store listing to send them to, in
    /// which case the screen states the requirement without a dead link.
    static let appStoreURL: URL? = {
        let raw = string("APEX_APP_STORE_URL")
        return raw.isEmpty ? nil : URL(string: raw)
    }()

    private static let shortVersion = string("CFBundleShortVersionString")
    private static let build = string("CFBundleVersion")

    /// Fails the launch rather than shipping a build pointed at the wrong backend.
    ///
    /// The simulator check is the harness rule made mechanical: a simulator build
    /// must never talk to production Supabase, exactly as `dev/envGuard` enforces
    /// for the web.
    static func assertSafe() {
        precondition(
            supabaseAnonKey != "REPLACE_ME" && !supabaseAnonKey.isEmpty,
            """
            SUPABASE_ANON_KEY is still the placeholder. Copy \
            ios/Config/Secrets.xcconfig.example to ios/Config/Secrets.xcconfig \
            and fill it in.
            """
        )
        #if targetEnvironment(simulator)
        let host = supabaseURL.host() ?? ""
        precondition(
            host == "127.0.0.1" || host == "localhost",
            """
            The \(name) configuration points at \(host), but simulator builds must \
            use the local stack. Run the Apex scheme with the Local configuration.
            """
        )
        #endif
    }

    private static func string(_ key: String) -> String {
        Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
    }

    private static func url(_ key: String) -> URL {
        let raw = string(key)
        guard let url = URL(string: raw) else {
            preconditionFailure("\(key) is not a URL: \"\(raw)\"")
        }
        return url
    }
}
