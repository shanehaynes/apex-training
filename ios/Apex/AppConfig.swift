import Foundation

/// Build configuration, read from the Info.plist keys that the xcconfig files
/// fill in (D-022). Reading them at runtime rather than baking them into Swift
/// means a built app can be inspected to see what it points at.
enum AppConfig {
    static let apiBase = url("APEX_API_BASE")
    static let supabaseURL = url("SUPABASE_URL")
    static let supabaseAnonKey = string("SUPABASE_ANON_KEY")
    static let name = string("APEX_CONFIGURATION")

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
