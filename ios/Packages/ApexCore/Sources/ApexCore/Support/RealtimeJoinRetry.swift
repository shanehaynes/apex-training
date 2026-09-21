import Foundation

/// Whether live updates are actually flowing, per group (#223). A join that
/// keeps failing ends here rather than in the log alone: the hub retries on the
/// write queue's backoff, and when the attempts run out the group lands in
/// `unavailable` and stays there until a later join succeeds. Declared in
/// `ApexCore`, next to `RealtimeChanges`, so a view can render the state
/// without knowing what delivers it.
public struct RealtimeAvailability: Sendable, Equatable {
    /// Groups whose channel gave up rejoining. Empty means everything wanted is
    /// either joined or still trying.
    public var unavailable: Set<TableGroup>

    public init(unavailable: Set<TableGroup> = []) {
        self.unavailable = unavailable
    }

    public static let live = RealtimeAvailability()

    /// What a "live updates unavailable" banner keys off.
    public var isDegraded: Bool { !unavailable.isEmpty }
}

/// How a failed realtime join waits before trying again: `RetryPolicy`'s curve
/// (1s, 2s, 4s, … doubling, capped), bounded by a maximum number of attempts so
/// a channel the server will never accept — a table missing from the
/// publication, say — stops reconnecting and says so instead.
///
/// Pure, and separate from `RealtimeHub` so Linux CI proves the schedule:
/// `ApexKit` only compiles on a Mac.
public struct RealtimeJoinRetry: Sendable, Equatable {
    public enum Step: Sendable, Equatable {
        case retry(after: Double)
        /// No attempts left: the group is unavailable until something else
        /// (resume, a fresh subscribe) asks for it again.
        case giveUp
    }

    /// Total join attempts, the first one included. 6 is five retries over
    /// ~31 s — long enough to outlast a cold start with no network yet or a
    /// token still refreshing, short enough that the banner is not a lie.
    public var maxAttempts: Int
    /// The write queue's policy, not a second curve.
    public var policy: RetryPolicy

    public init(maxAttempts: Int = 6, policy: RetryPolicy = .default) {
        self.maxAttempts = maxAttempts
        self.policy = policy
    }

    public static let `default` = RealtimeJoinRetry()

    /// `failures` is how many join attempts have failed so far, the one that
    /// just failed included (so the first failure is 1). The delay matches what
    /// the write queue would wait after the same number of failures.
    public func step(afterFailures failures: Int) -> Step {
        guard failures < maxAttempts else { return .giveUp }
        // `backoff` clamps a negative count to 0, so a nonsense `failures` still
        // yields the base delay rather than something shorter than it.
        return .retry(after: policy.backoff(attempts: failures - 1))
    }
}
