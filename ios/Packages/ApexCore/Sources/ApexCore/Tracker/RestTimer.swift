import Foundation

/// The rest countdown between sets (D-015): starts when a set row commits its
/// first non-empty reps or duration, pre-filled from the exercise's rest
/// prescription, +15 s and skip, a one-shot signal at zero.
///
/// Pure state over an injected `now`, so the tracker model and `swift test`
/// drive it the same way. It stores the absolute `endsAt` and never
/// decrements: the in-app bar derives its label from `remaining(at:)` on the
/// tracker's one-second tick, and the Live Activity hands the same date to
/// `Text(timerInterval:)`, which counts down on its own while the app sleeps.
public struct RestTimer: Equatable, Sendable {
    /// What "+15 s" adds.
    public static let extensionSeconds: Double = 15
    /// How long after zero `settle` still counts as "just now": the tracker's
    /// tick is one second, and a tracker reopened minutes after the rest ran
    /// out clears the stale countdown without buzzing.
    public static let expiryGrace: Double = 2

    /// The instant the current rest ends; nil when none is running.
    public private(set) var endsAt: Date?
    /// When the current rest started — with `endsAt`, the length of this
    /// round, for a progress bar. Nil when none is running.
    public private(set) var startedAt: Date?
    /// Rows that have already started a timer this session. A row starts one
    /// on its first non-empty commit only: the second keystroke of "12" is not
    /// a second set.
    public private(set) var startedRows: Set<SetKey> = []

    public init() {}

    public var isRunning: Bool { endsAt != nil }

    /// Whole seconds left, rounded up so the bar reads "0:01" until the end
    /// has actually passed; 0 when nothing is running or it has.
    public func remaining(at now: Date) -> Int {
        guard let endsAt else { return 0 }
        return max(0, Int(endsAt.timeIntervalSince(now).rounded(.up)))
    }

    /// 0 at the start of the round, 1 at its end; 0 when nothing is running.
    public func progress(at now: Date) -> Double {
        guard let endsAt, let startedAt, endsAt > startedAt else { return 0 }
        return min(1, max(0, now.timeIntervalSince(startedAt) / endsAt.timeIntervalSince(startedAt)))
    }

    // MARK: - Transitions

    /// A set row committed `value` for `field`. Starts the timer when the value
    /// is non-empty, the field is reps or duration, the row has not started a
    /// timer yet and `rest` parses — a commit while a timer runs restarts it
    /// with this exercise's rest. Returns true when a timer was started.
    @discardableResult
    public mutating func setCommitted(_ key: SetKey, field: SetField, value: String, rest: String?, at now: Date) -> Bool {
        guard field != .weight, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        guard !startedRows.contains(key) else { return false }
        startedRows.insert(key)
        guard let seconds = Self.seconds(fromRest: rest) else { return false }
        start(seconds: seconds, at: now)
        return true
    }

    /// Rows that were already logged when the tracker opened — a resumed
    /// session, a replayed queue. Editing one later is a correction, not a set.
    public mutating func markLogged<S: Sequence>(_ keys: S) where S.Element == SetKey {
        startedRows.formUnion(keys)
    }

    public mutating func start(seconds: Double, at now: Date) {
        startedAt = now
        endsAt = now.addingTimeInterval(seconds)
    }

    /// +15 s onto the end — or onto `now` when the end has already passed, so a
    /// tap at zero gives a full fifteen seconds. Nothing when not running.
    public mutating func extend(at now: Date) {
        guard let endsAt else { return }
        self.endsAt = max(endsAt, now).addingTimeInterval(Self.extensionSeconds)
    }

    public mutating func skip() {
        endsAt = nil
        startedAt = nil
    }

    /// The tick: once the end has passed the timer clears itself. Returns true
    /// only when the end passed within `expiryGrace` of `now` — the haptic
    /// fires once, at zero, never late.
    @discardableResult
    public mutating func settle(at now: Date) -> Bool {
        guard let endsAt, now >= endsAt else { return false }
        let justNow = now.timeIntervalSince(endsAt) <= Self.expiryGrace
        skip()
        return justNow
    }

    /// Finish, cancel: nothing left to count, and the rows start fresh.
    public mutating func reset() {
        skip()
        startedRows = []
    }

    // MARK: - Prescription

    /// The rest prescription is free text. A single duration parses as
    /// `DurationBuffer` does ("90s", "2 min", "1:30"); a range ("60-90s",
    /// "2–3 min", "60 to 90s") takes its low end with the shared unit; anything
    /// else ("as needed") is no timer. Never zero or negative.
    public static func seconds(fromRest rest: String?) -> Double? {
        guard let rest else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return nil }
        // Ranges first: the plain parser reads "2-3 min" as a bare "2".
        for separator in ["-", "–", "—", " to "] {
            let parts = text.components(separatedBy: separator)
            guard parts.count == 2 else { continue }
            let low = parts[0].trimmingCharacters(in: .whitespaces)
            let high = parts[1].trimmingCharacters(in: .whitespaces)
            guard !low.isEmpty, low.allSatisfy({ $0.isNumber || $0 == "." }) else { continue }
            let unit = high.drop(while: { $0.isNumber || $0 == "." || $0 == ":" || $0 == " " })
            if let seconds = DurationBuffer.parseDurationSeconds(low + " " + unit), seconds > 0 { return seconds }
        }
        if let plain = DurationBuffer.parseDurationSeconds(text), plain > 0 { return plain }
        return nil
    }
}
