import ApexCore
import Foundation
import Observation

/// A workout that is running right now: which occurrence, and since when.
///
/// Two facts, because two facts are all the schedule needs to draw a timer —
/// the tracker's own state (the editor, the queue, the finish gate) stays
/// behind `TrackerModel` where it belongs.
public struct LiveSession: Equatable, Sendable {
    public let session: SessionKey
    /// On the *display* clock: the instant a system-driven timer has to count
    /// from to show this session's elapsed. Identical to the server's stamp
    /// under `SystemClock`; `TrackerHost.displayStart` says why it can differ.
    public let startedAt: Date

    public init(session: SessionKey, startedAt: Date) {
        self.session = session
        self.startedAt = startedAt
    }
}

/// The one live session the app knows about, written by `TrackerHost` and read
/// by the Schedule tab (ux-review §3.4): leaving the cover mid-workout used to
/// leave the Dynamic Island as the only thing saying a workout was running.
///
/// Deliberately not persisted. The durable copies already exist — the Live
/// Activity the system keeps across a kill, and the cached bootstrap the
/// tracker resumes from (D-024, architecture.md §7) — and a second store of
/// the same fact is a second store to get wrong. A relaunch starts empty and
/// the card is quiet until the tracker is opened again.
@MainActor
@Observable
public final class LiveSessionStore {
    public private(set) var current: LiveSession?

    /// Built inside `TrackerServices`, which is assembled off the main actor.
    public nonisolated init() {}

    /// D-031: a MainActor-default class needs a nonisolated deinit or deallocation
    /// off the main actor aborts on the iOS 17/18 runtime.
    nonisolated deinit {}

    /// What the tracker knows about `session`, folded in. A session that is no
    /// longer running only clears the store when the store is holding *it* —
    /// so a second occurrence opened over the first never wipes the first on
    /// its way past `.loading`.
    public func reflect(_ session: SessionKey, startedAt: Date?, isRunning: Bool) {
        if isRunning, let startedAt {
            current = LiveSession(session: session, startedAt: startedAt)
        } else if current?.session == session {
            current = nil
        }
    }

    /// `nil` unless this occurrence is the one that is running.
    public func startedAt(eventId: String, eventDate: String) -> Date? {
        guard let current, current.session == SessionKey(eventId: eventId, eventDate: eventDate) else { return nil }
        return current.startedAt
    }
}
