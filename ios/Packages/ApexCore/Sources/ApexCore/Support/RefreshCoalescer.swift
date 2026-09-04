import Foundation

/// Trailing debounce per key. Supabase emits one realtime event per changed
/// row, and a bulk edit on the web is many rows; the schedule wants one
/// refresh after the burst, not one per row (the web's `useDebouncedReload`,
/// 250 ms). Every caller awaits; only the last caller inside the quiet
/// period is told to act.
public actor RefreshCoalescer<Key: Hashable & Sendable> {
    private let quiet: Double
    private let clock: any ApexClock
    private var generation: [Key: Int] = [:]

    public init(quiet: Double, clock: any ApexClock = SystemClock()) {
        self.quiet = quiet
        self.clock = clock
    }

    /// True for exactly the request that survived the quiet period.
    public func request(_ key: Key) async -> Bool {
        let mine = (generation[key] ?? 0) + 1
        generation[key] = mine
        try? await clock.sleep(seconds: quiet)
        return generation[key] == mine
    }
}
