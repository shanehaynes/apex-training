import Foundation

/// Day (default) or Month — D-009 dropped the week view on the phone.
public enum ScheduleMode: Hashable, Sendable {
    case day, month
}

/// Why a window refresh was asked for; decides who hears about a failure.
public enum ScheduleRefreshReason: Sendable, Equatable {
    case launch, foreground, pullToRefresh, realtime, afterCompletion, retry
}
