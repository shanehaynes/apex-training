import Foundation

/// When the cache should admit to being cached (architecture.md §6): the
/// entry is older than `CachePolicy.staleAfter` **and** the last refresh
/// failed. A fresh failure says nothing worth a banner; an old success is
/// simply the current state.
public enum StaleAffordance {
    public static func label(fetchedAt: Date?, now: Date, lastRefreshFailed: Bool) -> String? {
        guard lastRefreshFailed, let fetchedAt else { return nil }
        guard now.timeIntervalSince(fetchedAt) > CachePolicy.staleAfter else { return nil }
        return "cached · updated \(relativeAge(from: fetchedAt, to: now)) ago"
    }

    /// Past the window's end the cache cannot know what is scheduled.
    public static func horizonLabel(showing day: DayKey, horizon: DayKey) -> String? {
        guard day > horizon else { return nil }
        return "schedule cached through \(MonthNames.short[horizon.month - 1]) \(horizon.day)"
    }

    /// `45m`, `3h`, `2d` — coarse on purpose; a banner is not a stopwatch.
    public static func relativeAge(from: Date, to: Date) -> String {
        let seconds = max(0, to.timeIntervalSince(from))
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}
