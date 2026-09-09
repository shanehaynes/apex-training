import ActivityKit
import ApexCore
import Foundation

/// The tracker's Live Activity (W12, D-016). The attributes are fixed for the
/// life of the activity; the ids ride along with the title because the tap URL
/// needs them and a relaunched app has nothing else to reconcile against.
public nonisolated struct TrackerActivityAttributes: ActivityAttributes, Sendable {
    public nonisolated struct ContentState: Codable, Hashable, Sendable {
        public nonisolated enum Phase: Codable, Hashable, Sendable {
            /// The system draws the elapsed time from `startedAt`; nothing pushes.
            case running
            /// Shown for a few minutes after finish, then dismissed.
            case done(totalSeconds: Int)
        }

        public var startedAt: Date
        public var exerciseCount: Int?
        public var phase: Phase
        /// Reserved for the rest timer between sets (D-015, Backlog). Unused.
        public var restEndsAt: Date?

        public init(startedAt: Date, exerciseCount: Int? = nil, phase: Phase = .running, restEndsAt: Date? = nil) {
            self.startedAt = startedAt
            self.exerciseCount = exerciseCount
            self.phase = phase
            self.restEndsAt = restEndsAt
        }

        public var isDone: Bool {
            if case .done = phase { return true }
            return false
        }
    }

    public var title: String
    public var eventId: String
    public var eventDate: String

    public init(title: String, eventId: String, eventDate: String) {
        self.title = title
        self.eventId = eventId
        self.eventDate = eventDate
    }

    public var session: SessionKey { SessionKey(eventId: eventId, eventDate: eventDate) }

    /// Where a tap lands: `apextraining://app/tracker/<eventId>/<date>`.
    /// Parsed by `DeepLink` in ApexCore (its `.tracker` case).
    public var url: URL { TrackerActivityURL.make(eventId: eventId, eventDate: eventDate) }
}

public nonisolated enum TrackerActivityURL {
    public static func make(eventId: String, eventDate: String) -> URL {
        var components = URLComponents()
        components.scheme = DeepLink.scheme
        components.host = "app"
        components.path = "/tracker/\(eventId)/\(eventDate)"
        return components.url!
    }
}
