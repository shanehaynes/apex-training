import ApexCore
import Foundation

/// What the tracker tells the Live Activity, at the three moments that matter
/// (architecture.md §12): the session is open and running, it finished, it was
/// cancelled. `TrackerModel` speaks to this protocol; the app injects
/// `LiveActivityController`, tests inject a spy, previews and the XCUITest
/// smoke get `NoActivityPublisher`.
public nonisolated protocol TrackerActivityPublishing: Sendable {
    /// Start the activity for this session if there is none, update it if the
    /// snapshot changed. Idempotent on purpose: `open()` can settle `startedAt`
    /// twice (an offline stamp, then the server's echo of it) and the island
    /// must agree with the tracker header either way.
    func sync(_ snapshot: TrackerActivitySnapshot) async
    /// End the session's activity and take it off the Lock Screen at once.
    /// With a total (finish) the final content records it; without one (cancel)
    /// any activity for the session still on screen goes.
    func end(_ session: SessionKey, totalSeconds: Int?) async
}

public nonisolated struct TrackerActivitySnapshot: Sendable, Equatable {
    public var session: SessionKey
    public var title: String
    public var startedAt: Date
    public var exerciseCount: Int?

    public init(session: SessionKey, title: String, startedAt: Date, exerciseCount: Int? = nil) {
        self.session = session
        self.title = title
        self.startedAt = startedAt
        self.exerciseCount = exerciseCount
    }

    public var attributes: TrackerActivityAttributes {
        TrackerActivityAttributes(title: title, eventId: session.eventId, eventDate: session.eventDate)
    }

    public var state: TrackerActivityAttributes.ContentState {
        TrackerActivityAttributes.ContentState(startedAt: startedAt, exerciseCount: exerciseCount, phase: .running)
    }
}

/// The default: nothing happens. Previews, the XCUITest smoke and the unit
/// tests that do not care about the island run on this.
public nonisolated struct NoActivityPublisher: TrackerActivityPublishing {
    public init() {}
    public func sync(_ snapshot: TrackerActivitySnapshot) async {}
    public func end(_ session: SessionKey, totalSeconds: Int?) async {}
}

/// Where the Live Activity's APNs tokens go (phase52). Fire-and-forget: a
/// token that fails to register costs the push, never the card — the app
/// still ends the activity itself when it next runs.
public nonisolated protocol LiveActivityTokenSink: Sendable {
    func register(_ registration: LiveActivityTokenRegistration) async
    /// The app ended the session's activity; the server can drop its tokens.
    func forget(_ session: SessionKey) async
}

/// The app's sink: `/api/live-activity-tokens` through the signed-in client.
public nonisolated struct APITokenSink: LiveActivityTokenSink {
    private let client: ApexClient

    public init(client: ApexClient) {
        self.client = client
    }

    public func register(_ registration: LiveActivityTokenRegistration) async {
        _ = try? await client.data(for: .liveActivityToken(registration))
    }

    public func forget(_ session: SessionKey) async {
        _ = try? await client.data(for: .forgetLiveActivityTokens(session))
    }
}
