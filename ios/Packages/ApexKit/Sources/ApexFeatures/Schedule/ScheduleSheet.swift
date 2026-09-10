import ApexCore
import Foundation

/// What the Schedule tab can present over itself (screens.md: event sheet, day
/// sheet, the builder, the exercises editor). Pushed routes arrive with W10
/// (library).
enum ScheduleSheet: Identifiable, Hashable {
    case event(id: String)
    case day(DayKey)
    /// The workout builder (W7): a new workout on a day, or an existing event.
    case builder(BuilderRoute)
    /// "Edit exercises" on the event sheet: series-wide, sections only.
    case editExercises(id: String)

    var id: String {
        switch self {
        case .event(let id): "event:\(id)"
        case .day(let day): "day:\(day.string)"
        case .builder(let route): "builder:\(route.id)"
        case .editExercises(let id): "exercises:\(id)"
        }
    }
}

/// How the builder opens (`OPEN_COMPOSER` / `OPEN_EVENT_EDITOR` on the web).
public enum BuilderRoute: Hashable, Sendable, Identifiable {
    case create(date: DayKey)
    case edit(eventId: String)

    public var id: String {
        switch self {
        case .create(let date): "create:\(date.string)"
        case .edit(let id): "edit:\(id)"
        }
    }
}
