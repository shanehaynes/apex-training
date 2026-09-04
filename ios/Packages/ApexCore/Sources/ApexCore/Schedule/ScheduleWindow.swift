import Foundation

/// The one window the app keeps: `[today − 60d, today + 120d]`
/// (architecture.md §6). The window *is* the offline cache — there is no
/// local recurrence expansion — so a phone offline past `end` shows
/// "schedule cached through <date>" rather than guessing.
public struct ScheduleWindow: Sendable, Equatable {
    public static let daysBack = 60
    public static let daysForward = 120

    public let start: DayKey
    public let end: DayKey

    public init(start: DayKey, end: DayKey) {
        self.start = start
        self.end = end
    }

    public static func around(_ today: DayKey) -> ScheduleWindow {
        ScheduleWindow(start: today.adding(days: -daysBack), end: today.adding(days: daysForward))
    }

    public func contains(_ day: DayKey) -> Bool {
        start <= day && day <= end
    }
}

/// Keys under each `CacheKind`. The schedule window is stored under one
/// constant key: the window travels inside the cached response, so a day that
/// rolls over still renders yesterday's cache and no rows are orphaned.
public enum ScheduleCacheKey {
    public static let window = "current"
    public static let definitions = "all"
    public static let templates = "all"
    public static let profile = "me"

    /// `meals_window` is cached per month, `yyyy-MM`.
    public static func meals(year: Int, month: Int) -> String {
        String(format: "%04d-%02d", year, month)
    }
}
