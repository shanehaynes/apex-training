import Foundation
// URLRequest lives in FoundationNetworking on Linux, not Foundation. Without this
// ApexCore does not compile there — which is the whole point of the package, so
// CI's apexcore-linux job is what catches a missing one.
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How a build names itself to the server.
///
/// The web and the API deploy atomically, so the server could always assume a
/// caller no older than itself. A binary in the App Store breaks that: it runs
/// for as long as someone leaves it installed. `X-Apex-Client` is how a log
/// line can say which build produced the traffic.
public enum ClientTag {
    public static let header = "X-Apex-Client"

    /// `ios/0.6.0+312` — the marketing version and the build, exactly as the
    /// bundle spells them. The app builds one from `CFBundleShortVersionString`
    /// and `CFBundleVersion`; nothing here reads a bundle, so this stays
    /// Linux-testable.
    public static func ios(version: String, build: String) -> String {
        "ios/\(version)+\(build)"
    }

    /// `CFBundleVersion` as the integer the gate compares — 0 when it is not a
    /// plain integer, which the gate then refuses to block on.
    public static func buildNumber(_ raw: String) -> Int {
        Int(raw.trimmingCharacters(in: .whitespaces)) ?? 0
    }
}

/// `GET /api/version` — `{ sha, minBuild, message? }`.
///
/// `minBuild` is decoded leniently: a deployment older than the gate itself
/// answers `{ sha }` alone, and that must read as "no floor", not as a decode
/// failure that hides the SHA too.
public struct VersionInfo: Decodable, Sendable, Equatable {
    public let sha: String
    public let minBuild: Int
    public let message: String?

    public init(sha: String, minBuild: Int = 0, message: String? = nil) {
        self.sha = sha
        self.minBuild = minBuild
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case sha, minBuild, message }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sha = try container.decode(String.self, forKey: .sha)
        minBuild = try container.decodeIfPresent(Int.self, forKey: .minBuild) ?? 0
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }
}

/// The launch check: is this build still one the server serves?
///
/// Everything about it fails open. A build the server has retired keeps
/// working until the gate is *positively* told otherwise — an offline launch,
/// a 500, a body that does not parse, an unreadable build number all mean "not
/// blocked". The failure this exists to prevent (a write that 400s forever
/// because a column moved) is bad; an app that refuses to open because the
/// network was down on the wrong morning is worse.
public enum UpdateGate {
    /// What the blocking screen says when the deployment names no reason.
    public static let defaultMessage =
        "This version of Apex is out of date and can no longer sync. Update to keep training."

    /// The message to show, or nil when this build is still served.
    public static func verdict(build: Int, info: VersionInfo) -> String? {
        guard info.minBuild > 0, build > 0, build < info.minBuild else { return nil }
        let message = info.message?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (message?.isEmpty == false ? message : nil) ?? defaultMessage
    }

    /// Reads `/api/version` and applies `verdict`. Unauthenticated on purpose:
    /// the handler asks for no token, and the check has to answer a launch that
    /// is not signed in yet.
    public static func check(
        build: Int,
        baseURL: URL,
        transport: any HTTPTransport
    ) async -> String? {
        guard let info = await fetch(baseURL: baseURL, transport: transport) else { return nil }
        return verdict(build: build, info: info)
    }

    /// The raw read, for anything that wants the SHA too. Nil on any failure.
    public static func fetch(baseURL: URL, transport: any HTTPTransport) async -> VersionInfo? {
        guard let url = Endpoint(path: "api/version").url(relativeTo: baseURL) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        guard let response = try? await transport.send(request),
              (200..<300).contains(response.status),
              let info = try? JSONDecoder().decode(VersionInfo.self, from: response.body)
        else { return nil }
        return info
    }
}
