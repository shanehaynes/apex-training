import ApexCore
import Foundation

/// What the You tab needs from the app (W11): the client, who is signed in,
/// the public origin the MCP endpoint and the legal pages hang off, and the
/// hooks into the parts of the app a profile edit reaches — the coach's model
/// badge, the schedule after a COROS import, the session on sign-out and
/// after the account is gone. Built once by `AppModel` per signed-in user,
/// like `CoachServices`.
public struct YouServices: Sendable {
    public var client: ApexClient
    /// The web app's origin: `<origin>/api/mcp` is the connector endpoint and
    /// `<origin>/terms` · `/privacy` the legal pages.
    public var publicOrigin: URL
    public var email: String?
    public var timeZone: TimeZone
    public var clock: any ApexClock
    /// The app's version line for About ("0.6.0 (312)").
    public var versionLabel: String
    /// Sets a new password on the signed-in session; an error message or nil.
    public var changePassword: @MainActor @Sendable (String) async -> String?
    /// A profile write landed — the Coach tab re-reads its badge and key state.
    public var onProfileChanged: @MainActor @Sendable () -> Void
    /// A COROS apply wrote events — the Schedule tab refreshes its window.
    public var onScheduleChanged: @MainActor @Sendable () -> Void
    /// `DELETE /api/account` succeeded: the JWT no longer resolves, so the app
    /// drops the session the way the web does.
    public var onAccountDeleted: @MainActor @Sendable () -> Void
    public var signOut: @MainActor @Sendable () -> Void
    /// The Library screens' reads over the schedule's cache (W10); nil hides
    /// the rows (previews, tests that do not exercise them).
    public var library: LibraryDependencies?
    /// The Blocks screens (W10); nil hides the row.
    public var blocks: BlocksDependencies?

    public init(
        client: ApexClient, publicOrigin: URL, email: String?, timeZone: TimeZone = .current,
        clock: any ApexClock = SystemClock(), versionLabel: String = "",
        changePassword: @escaping @MainActor @Sendable (String) async -> String? = { _ in nil },
        onProfileChanged: @escaping @MainActor @Sendable () -> Void = {},
        onScheduleChanged: @escaping @MainActor @Sendable () -> Void = {},
        onAccountDeleted: @escaping @MainActor @Sendable () -> Void = {},
        signOut: @escaping @MainActor @Sendable () -> Void = {},
        library: LibraryDependencies? = nil,
        blocks: BlocksDependencies? = nil
    ) {
        self.client = client
        self.publicOrigin = publicOrigin
        self.email = email
        self.timeZone = timeZone
        self.clock = clock
        self.versionLabel = versionLabel
        self.changePassword = changePassword
        self.onProfileChanged = onProfileChanged
        self.onScheduleChanged = onScheduleChanged
        self.onAccountDeleted = onAccountDeleted
        self.signOut = signOut
        self.library = library
        self.blocks = blocks
    }

    /// `<origin>/api/mcp` — what an AI app is given as its server URL.
    public var mcpEndpoint: URL { publicOrigin.appendingPathComponent("api/mcp") }
    public var termsURL: URL { publicOrigin.appendingPathComponent("terms") }
    public var privacyURL: URL { publicOrigin.appendingPathComponent("privacy") }
}

/// The screens the You root pushes.
public enum YouRoute: Hashable, Sendable {
    case name, avatar, password
    case heartRate
    /// W10: the exercise library, one exercise, the workout library.
    case library, exercise(id: String), workoutLibrary
    /// W10: the training blocks, one block.
    case blocks, block(id: String)
    case coachProfile, coachModel
    case coros, calendarFeed, connector, connectorGuide
    case activity, deleteAccount, about
}

/// What one `/api/*` failure should say. The server's own message when it
/// sent one (Anthropic's text on a bad key, "Invalid max_hr"), the offline
/// line otherwise.
enum Failure {
    static func message(_ error: Error) -> String {
        if let apiError = error as? APIError {
            switch apiError {
            case .server(_, let message?) where !message.isEmpty: return message
            case .network: return "You're offline — try again when connected."
            default: return apiError.description
            }
        }
        return error.localizedDescription
    }
}

/// ISO timestamps from the API, read for display. The server writes
/// `2026-09-08T12:00:00.000Z` (Postgres via PostgREST) and sometimes without
/// the fraction; both parse. Unparseable input renders as itself rather than
/// hiding the row.
enum IsoDate {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return fractional.date(from: iso) ?? plain.date(from: iso)
    }

    /// "Sep 8, 14:05" — the activity log's column (`format(parseISO(...), 'MMM d, HH:mm')`).
    static func logTime(_ iso: String, timeZone: TimeZone) -> String {
        guard let date = parse(iso) else { return iso }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "MMM d, HH:mm"
        return f.string(from: date)
    }

    /// "Sep 8 3:40 PM" — `CorosConnection.tsx`'s `formatWhen`; "never" for nil.
    static func when(_ iso: String?, timeZone: TimeZone) -> String {
        guard let iso, let date = parse(iso) else { return "never" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "MMM d h:mm a"
        return f.string(from: date)
    }

    /// "2026-09-08" — the token list's `created_at.slice(0, 10)`.
    static func day(_ iso: String) -> String { String(iso.prefix(10)) }
}
