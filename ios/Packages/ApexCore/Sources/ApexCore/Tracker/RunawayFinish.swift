import Foundation

/// `src/lib/tracking/runawayFinish.ts` (D-061): a tracked session left running
/// asks at Finish when it really ended (docs/specs/tracker-runaway-finish).
/// Decided at Finish, possibly offline, so the server cannot own it; both
/// suites run `Tests/ApexCoreTests/Fixtures/runaway-finish.json`, so this port
/// cannot drift from the web's rule.
public struct RunawayFinish: Equatable, Sendable {
    /// More than this many times the planned length…
    public static let planMultiple: Double = 4
    /// …and more than this long, in seconds.
    public static let floorSeconds: Double = 2 * 60 * 60

    /// Where a suggested finish came from, so the card can say so.
    public enum Basis: String, Equatable, Sendable {
        case lastLogged = "last-logged"
        case plan
        case now
    }

    public struct Suggestion: Equatable, Sendable {
        public let at: Date
        public let basis: Basis

        public init(at: Date, basis: Basis) {
            self.at = at
            self.basis = basis
        }
    }

    public let elapsedSeconds: Double
    public let plannedMinutes: Double
    public let suggestion: Suggestion

    public init(elapsedSeconds: Double, plannedMinutes: Double, suggestion: Suggestion) {
        self.elapsedSeconds = elapsedSeconds
        self.plannedMinutes = plannedMinutes
        self.suggestion = suggestion
    }

    /// A positive, finite number of minutes, or nil: anything else is no plan.
    private static func plan(_ plannedMinutes: Double?) -> Double? {
        guard let minutes = plannedMinutes, minutes.isFinite, minutes > 0 else { return nil }
        return minutes
    }

    /// More than 4× the plan and more than 2 hours. Exactly at either bound is
    /// not a runaway; a session with no plan never is.
    public static func isRunaway(elapsedSeconds: Double, plannedMinutes: Double?) -> Bool {
        guard let minutes = plan(plannedMinutes), elapsedSeconds.isFinite else { return false }
        return elapsedSeconds > floorSeconds && elapsedSeconds > planMultiple * minutes * 60
    }

    /// When the session most likely ended: the last logged set when it falls
    /// after the start and no later than now; otherwise the start plus the
    /// plan, never past now; with no plan either, now.
    public static func suggestFinish(startedAt: Date, now: Date, plannedMinutes: Double?, lastLoggedAt: Date?) -> Suggestion {
        if let last = lastLoggedAt, last > startedAt, last <= now {
            return Suggestion(at: last, basis: .lastLogged)
        }
        guard let minutes = plan(plannedMinutes) else { return Suggestion(at: now, basis: .now) }
        return Suggestion(at: min(now, startedAt.addingTimeInterval(minutes * 60)), basis: .plan)
    }

    /// What the Finish card needs, or nil when Finish should go straight through.
    public static func detect(startedAt: Date, now: Date, plannedMinutes: Double?, lastLoggedAt: Date?) -> RunawayFinish? {
        let elapsed = now.timeIntervalSince(startedAt)
        guard let minutes = plan(plannedMinutes), isRunaway(elapsedSeconds: elapsed, plannedMinutes: minutes) else { return nil }
        return RunawayFinish(
            elapsedSeconds: elapsed, plannedMinutes: minutes,
            suggestion: suggestFinish(startedAt: startedAt, now: now, plannedMinutes: minutes, lastLoggedAt: lastLoggedAt)
        )
    }

    /// "29 min", "3 h 24 min", "19 d 15 h": whole minutes, rounded down, like a timer.
    public static func formatLength(seconds: Double) -> String {
        let total = seconds.isFinite ? Int((max(0, seconds) / 60).rounded(.down)) : 0
        let d = total / 1440
        let h = (total % 1440) / 60
        let m = total % 60
        if d > 0 { return h > 0 ? "\(d) d \(h) h" : "\(d) d" }
        if h > 0 { return m > 0 ? "\(h) h \(m) min" : "\(h) h" }
        return "\(m) min"
    }
}
