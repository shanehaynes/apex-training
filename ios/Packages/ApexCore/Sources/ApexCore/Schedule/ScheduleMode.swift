import Foundation

/// Day (default) or Month — D-009 dropped the week view on the phone.
public enum ScheduleMode: Hashable, Sendable {
    case day, month
}

/// Why a window refresh was asked for; decides who hears about a failure.
public enum ScheduleRefreshReason: Sendable, Equatable {
    case launch, foreground, pullToRefresh, realtime, afterCompletion, retry
    /// A confirmed coach action landed on the server (W6); realtime covers the
    /// tables it touched, but not the completion rows a retro-log writes.
    case coachMutation
    /// An event write from the sheet or the builder landed (W7); same reason
    /// as `coachMutation` — a retro-log create writes completion rows realtime
    /// does not announce.
    case afterEdit
}
