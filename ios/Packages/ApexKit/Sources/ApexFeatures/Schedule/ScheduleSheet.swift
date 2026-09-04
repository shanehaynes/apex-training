import ApexCore
import Foundation

/// What the Schedule tab can present over itself (screens.md: event sheet, day
/// sheet). Pushed routes arrive with W4 (tracker) and W10 (library).
enum ScheduleSheet: Identifiable, Hashable {
    case event(id: String)
    case day(DayKey)

    var id: String {
        switch self {
        case .event(let id): "event:\(id)"
        case .day(let day): "day:\(day.string)"
        }
    }
}
