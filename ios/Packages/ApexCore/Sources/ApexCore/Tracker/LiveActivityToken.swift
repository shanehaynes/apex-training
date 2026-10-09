import Foundation

/// One APNs token ActivityKit issued for the tracker's Live Activity, as
/// `POST /api/live-activity-tokens` takes it (phase52). The server keeps it so
/// a workout finished anywhere else can end the Lock Screen card by push.
public struct LiveActivityTokenRegistration: Encodable, Equatable, Sendable {
    /// Which APNs host the token belongs to. A build signed with a development
    /// profile gets sandbox tokens; TestFlight and the App Store get production.
    public enum Environment: String, Encodable, Sendable {
        case sandbox, production
    }

    public let eventId: String
    public let eventDate: String
    /// Lower-case hex, the conventional spelling of a device token.
    public let token: String
    public let environment: Environment
    /// ISO-8601, UTC: the activity's own `startedAt`, so the server's `end`
    /// carries the start the card was drawing from.
    public let startedAt: String

    public init(session: SessionKey, token: Data, environment: Environment, startedAt: Date) {
        self.eventId = session.eventId
        self.eventDate = session.eventDate
        self.token = Self.hex(token)
        self.environment = environment
        self.startedAt = CompletionRows.isoTimestamp(startedAt)
    }

    public static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

extension Endpoint {
    /// Register a Live Activity push token (`api/_lib/handlers/liveActivityTokens.ts`).
    public static func liveActivityToken(_ registration: LiveActivityTokenRegistration) -> Endpoint {
        Endpoint(method: .post, path: "api/live-activity-tokens", body: json(registration))
    }

    /// The app ended the session's activity itself: the server has nothing left to push.
    public static func forgetLiveActivityTokens(_ session: SessionKey) -> Endpoint {
        Endpoint(
            method: .delete,
            path: "api/live-activity-tokens",
            query: [URLQueryItem(name: "eventId", value: session.eventId), URLQueryItem(name: "eventDate", value: session.eventDate)]
        )
    }
}
