import ActivityKit
import ApexCore
import Foundation
import os

/// The app's side of the Live Activity: requests, updates and ends
/// `Activity<TrackerActivityAttributes>` on behalf of `TrackerModel`, and
/// reconciles whatever the system kept alive across an app kill.
///
/// Stateless on purpose. `Activity` is not `Sendable`, so holding one across
/// an isolation boundary is a Swift 6 error; ActivityKit's own
/// `Activity.activities` is the source of truth anyway, and it is the one
/// record that survives a kill — a cached handle would not.
///
/// One activity at a time (D-026): a workout is one thing in the island, and
/// starting a second session ends the first's activity rather than stacking.
/// Never spawns outside the tracker screen: `adoptExisting` only reconciles
/// what is already there.
public nonisolated struct LiveActivityController: TrackerActivityPublishing {
    public static let doneLingers: TimeInterval = 5 * 60

    private let log = Logger(subsystem: "com.shanehaynes.apextraining", category: "activity")

    public init() {}

    // MARK: - TrackerActivityPublishing

    public func sync(_ snapshot: TrackerActivitySnapshot) async {
        await endAll(except: snapshot.session)
        if let live = Self.live(for: snapshot.session) {
            // Left behind by a kill, or the same session re-opened: keep it,
            // and only touch it if the snapshot moved.
            if live.content.state != snapshot.state {
                await live.update(ActivityContent(state: snapshot.state, staleDate: nil))
            }
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            log.info("Live Activities are off in Settings; not requesting one")
            return
        }
        do {
            _ = try Activity.request(
                attributes: snapshot.attributes,
                content: ActivityContent(state: snapshot.state, staleDate: nil),
                pushType: nil
            )
        } catch {
            // Not fatal: the tracker works without the island.
            log.error("Activity.request failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func end(_ session: SessionKey, totalSeconds: Int?) async {
        if let totalSeconds {
            guard let activity = Self.live(for: session) else { return }
            var state = activity.content.state
            state.phase = .done(totalSeconds: totalSeconds)
            await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(.now + Self.doneLingers))
        } else {
            // A cancel after a finish: the activity is already `.ended` and
            // lingering on the Lock Screen as "Done" — that has to go too, so
            // this matches anything not yet dismissed, not only the live ones.
            for activity in Self.all where activity.attributes.session == session && activity.activityState.isOnScreen {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    // MARK: - Relaunch

    /// The system keeps an activity for hours after the app that requested it
    /// dies. On launch, leave the ones whose session is still open (a finish or
    /// cancel later ends them) and end the rest now — a finished session, or one
    /// whose cache is gone (cancel purges it), has no business in the island.
    public func adoptExisting(isSessionOpen: @Sendable (SessionKey) async -> Bool) async {
        for activity in Self.all where activity.activityState.isLive {
            let session = activity.attributes.session
            if await isSessionOpen(session) {
                log.info("keeping a live activity for \(session.eventId, privacy: .public)")
            } else {
                log.info("ending a stale activity for \(session.eventId, privacy: .public)")
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// Sign-out: nothing in the island belongs to the next account.
    public func endAll() async {
        await endAll(except: nil)
    }

    private func endAll(except keep: SessionKey?) async {
        for activity in Self.all where activity.attributes.session != keep && activity.activityState.isLive {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private static var all: [Activity<TrackerActivityAttributes>] { Activity<TrackerActivityAttributes>.activities }

    private static func live(for session: SessionKey) -> Activity<TrackerActivityAttributes>? {
        all.first { $0.attributes.session == session && $0.activityState.isLive }
    }
}

private nonisolated extension ActivityState {
    /// `.active` and `.stale` are running; `.ended` is finished but may still be
    /// lingering on the Lock Screen; `.dismissed` is gone.
    var isLive: Bool {
        switch self {
        case .active, .stale: true
        default: false
        }
    }

    var isOnScreen: Bool {
        switch self {
        case .active, .stale, .ended: true
        default: false
        }
    }
}
