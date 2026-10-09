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
///
/// With a token sink the activity is requested with `pushType: .token` and
/// every APNs token ActivityKit issues for it goes to the server (phase52),
/// which pushes `end` when the workout is finished somewhere the phone cannot
/// see — the web, the calendar, the coach — even while the app is suspended.
/// A request the system refuses with push (no `aps-environment` entitlement,
/// say) is retried without it: the card matters more than the push.
public nonisolated struct LiveActivityController: TrackerActivityPublishing {
    /// How long a running activity's content is trusted. A session finished on
    /// the web, or an app killed mid-workout, leaves ActivityKit rendering a
    /// timer nobody is updating; past this the system marks the activity stale
    /// and the views say so instead of counting up forever. Four hours is
    /// longer than any real session and short enough that a forgotten one does
    /// not lie all day.
    public static let staleAfter: TimeInterval = 4 * 60 * 60

    private let log = Logger(subsystem: "com.shanehaynes.apextraining", category: "activity")
    private let tokens: (any LiveActivityTokenSink)?
    private let environment: LiveActivityTokenRegistration.Environment

    /// `tokens` nil requests activities without push, as before phase52.
    /// `environment` is the APNs host this build's tokens belong to.
    public init(tokens: (any LiveActivityTokenSink)? = nil, environment: LiveActivityTokenRegistration.Environment = .production) {
        self.tokens = tokens
        self.environment = environment
    }

    /// The moment this content stops being believable: `startedAt + 4h` while
    /// the workout is running, and nothing for a finished one — a `.done` state
    /// carries a fixed total that is as true in an hour as it is now.
    public static func staleDate(for state: TrackerActivityAttributes.ContentState) -> Date? {
        state.isDone ? nil : state.startedAt.addingTimeInterval(staleAfter)
    }

    // MARK: - TrackerActivityPublishing

    public func sync(_ snapshot: TrackerActivitySnapshot) async {
        await endAll(except: snapshot.session)
        if let live = Self.live(for: snapshot.session) {
            // Left behind by a kill, or the same session re-opened: keep it,
            // and only touch it if the snapshot moved.
            if live.content.state != snapshot.state {
                await live.update(ActivityContent(state: snapshot.state, staleDate: Self.staleDate(for: snapshot.state)))
            }
            watchTokens(of: live.id)
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            log.info("Live Activities are off in Settings; not requesting one")
            return
        }
        let content = ActivityContent(state: snapshot.state, staleDate: Self.staleDate(for: snapshot.state))
        do {
            let activity: Activity<TrackerActivityAttributes>
            if tokens != nil {
                do {
                    activity = try Activity.request(attributes: snapshot.attributes, content: content, pushType: .token)
                } catch {
                    log.error("Activity.request with push failed, retrying without: \(error.localizedDescription, privacy: .public)")
                    activity = try Activity.request(attributes: snapshot.attributes, content: content, pushType: nil)
                }
            } else {
                activity = try Activity.request(attributes: snapshot.attributes, content: content, pushType: nil)
            }
            watchTokens(of: activity.id)
        } catch {
            // Not fatal: the tracker works without the island.
            log.error("Activity.request failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func end(_ session: SessionKey, totalSeconds: Int?) async {
        if let totalSeconds {
            // A finished workout leaves the Lock Screen at once. The final
            // "Done" content is still handed over so the system's last record
            // of the activity carries the total, but nothing lingers: the
            // summary in the app is where the result lives.
            guard let activity = Self.live(for: session) else {
                await tokens?.forget(session)
                return
            }
            var state = activity.content.state
            state.phase = .done(totalSeconds: totalSeconds)
            await activity.end(ActivityContent(state: state, staleDate: Self.staleDate(for: state)), dismissalPolicy: .immediate)
        } else {
            // Cancel: anything not yet dismissed goes, not only the live ones,
            // so an `.ended` activity the system has not cleared yet goes too.
            for activity in Self.all where activity.attributes.session == session && activity.activityState.isOnScreen {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        // Ended here: the server has nothing left to push to.
        await tokens?.forget(session)
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
                watchTokens(of: activity.id)
            } else {
                log.info("ending a stale activity for \(session.eventId, privacy: .public)")
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// A workout finished anywhere but this tracker — on the web, from the
    /// Schedule's check, by the coach — never reaches `end`, so the activity
    /// would keep counting until it went stale. The app calls this after every
    /// schedule refresh (launch, foreground, realtime, a completion toggle) and
    /// ends, at once, any running activity whose session is now finished.
    public func endFinished(where isFinished: @Sendable (SessionKey) -> Bool) async {
        for activity in Self.all where activity.activityState.isLive {
            let session = activity.attributes.session
            guard isFinished(session) else { continue }
            log.info("ending an activity finished elsewhere for \(session.eventId, privacy: .public)")
            await activity.end(nil, dismissalPolicy: .immediate)
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

    // MARK: - Push tokens

    /// Forward every token ActivityKit issues for this activity — the first
    /// one and each rotation — until the activity ends. Keyed by the
    /// activity's id, which is `Sendable` where the activity is not: the
    /// watching task looks the activity up itself, so no handle crosses an
    /// isolation boundary. One watcher per activity, however often `sync`
    /// runs for it.
    private func watchTokens(of id: String) {
        guard let tokens else { return }
        let environment = environment
        Task.detached {
            guard await TokenWatchers.shared.claim(id) else { return }
            if let activity = Activity<TrackerActivityAttributes>.activities.first(where: { $0.id == id }) {
                let session = activity.attributes.session
                // A relaunch re-watches an activity whose token was issued
                // before the kill; the current one may never come round again.
                if let token = activity.pushToken {
                    await tokens.register(LiveActivityTokenRegistration(
                        session: session, token: token, environment: environment, startedAt: activity.content.state.startedAt
                    ))
                }
                for await token in activity.pushTokenUpdates {
                    await tokens.register(LiveActivityTokenRegistration(
                        session: session, token: token, environment: environment, startedAt: activity.content.state.startedAt
                    ))
                }
            }
            await TokenWatchers.shared.release(id)
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

/// The activity ids whose tokens are being watched, so a second `sync` for
/// the same activity does not start a second watcher.
private actor TokenWatchers {
    static let shared = TokenWatchers()
    private var ids: Set<String> = []

    func claim(_ id: String) -> Bool { ids.insert(id).inserted }
    func release(_ id: String) { ids.remove(id) }
}
