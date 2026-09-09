import ApexCore
import Foundation
import Observation

/// The four tabs (D-012), as the selection the root `TabView` binds to.
public enum AppTab: Hashable, Sendable {
    case schedule, coach, analytics, you
}

/// Where a non-auth deep link goes. `AppModel.open` parks the link here; the
/// tab it belongs to selects itself and consumes it when it can (a cold launch
/// has no schedule index yet, so consumption waits on the model, not the link).
///
/// W12 consumes `.tracker` (the Live Activity's tap). `.event` and `.library`
/// are parked for W7 and W10, which reuse this bus rather than add another.
@MainActor
@Observable
public final class RouteBus {
    public var tab: AppTab = .schedule
    public private(set) var pending: DeepLink?

    public init() {}

    public func open(_ link: DeepLink) {
        guard let tab = Self.tab(for: link) else { return }
        pending = link
        self.tab = tab
    }

    /// The consumer takes the link it handles and leaves anything else parked.
    public func take(where handles: (DeepLink) -> Bool) -> DeepLink? {
        guard let pending, handles(pending) else { return nil }
        self.pending = nil
        return pending
    }

    public static func tab(for link: DeepLink) -> AppTab? {
        switch link {
        case .event, .tracker: .schedule
        case .library: .you
        default: nil
        }
    }
}

/// `.tracker(id:date:)` → the occurrence the Schedule tab can present. The
/// window is the month around today, which the activity's few-hour life never
/// leaves in practice; a miss is a toast, not a fetch.
public enum TrackerRouteResolver {
    public static func route(for link: DeepLink, in index: ScheduleIndex?) -> TrackerRoute? {
        guard case .tracker(let id, let date) = link, let event = index?.event(id: id), event.date == date else { return nil }
        return TrackerRoute(event: event)
    }
}
