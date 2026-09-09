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
    /// End the session's activity. With a total the final "Done · 42:10" state
    /// stays up for a few minutes (finish); without one it goes at once (cancel).
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
