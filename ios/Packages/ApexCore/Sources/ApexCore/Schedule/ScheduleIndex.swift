import Foundation

/// One occurrence joined to its base — what a Day cell, a Month chip and the
/// event sheet all render. Completion state comes from the stub; the base's
/// own `isCompleted` is always false by server construction.
public struct ScheduleEvent: Identifiable, Sendable, Equatable, Hashable {
    public let occurrence: Occurrence
    public let base: WorkoutEventBase
    public let day: DayKey

    init?(occurrence: Occurrence, base: WorkoutEventBase) {
        guard let day = DayKey(occurrence.date) else { return nil }
        self.occurrence = occurrence
        self.base = base
        self.day = day
    }

    public var id: String { occurrence.id }
    public var date: String { occurrence.date }
    public var isCompleted: Bool { occurrence.isCompleted }
    public var completedAt: String? { occurrence.completedAt }
    /// A moved occurrence carries its own time on the stub; everything else
    /// inherits the base's.
    public var startTime: String? { occurrence.startTime ?? base.startTime }
    public var endTime: String? { occurrence.endTime ?? base.endTime }
    public var title: String { base.title }
    public var type: WorkoutType { base.type }
    public var estimatedDuration: Int? { base.estimatedDuration }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(isCompleted)
    }
}

/// `ScheduleResponse` indexed for rendering: events by day, sorted the way the
/// web sorts them (start time ascending, untimed last, then title).
public struct ScheduleIndex: Sendable, Equatable {
    public let response: ScheduleResponse
    public let byDay: [DayKey: [ScheduleEvent]]
    private let byId: [String: ScheduleEvent]

    public init(_ response: ScheduleResponse) {
        self.response = response
        let bases = Dictionary(response.bases.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var byDay: [DayKey: [ScheduleEvent]] = [:]
        var byId: [String: ScheduleEvent] = [:]
        for stub in response.occurrences {
            // A stub whose base is missing cannot be rendered; the server never
            // emits one, so dropping it is safer than crashing on it.
            guard let base = bases[stub.baseId], let event = ScheduleEvent(occurrence: stub, base: base) else { continue }
            byDay[event.day, default: []].append(event)
            byId[event.id] = event
        }
        for key in byDay.keys {
            byDay[key]?.sort(by: ScheduleIndex.displayOrder)
        }
        self.byDay = byDay
        self.byId = byId
    }

    static func displayOrder(_ a: ScheduleEvent, _ b: ScheduleEvent) -> Bool {
        let am = a.startTime.flatMap(TimeLabel.minutes) ?? Int.max
        let bm = b.startTime.flatMap(TimeLabel.minutes) ?? Int.max
        if am != bm { return am < bm }
        if a.title != b.title { return a.title < b.title }
        return a.id < b.id
    }

    public var window: ScheduleWindow? {
        guard let start = DayKey(response.window.start), let end = DayKey(response.window.end) else { return nil }
        return ScheduleWindow(start: start, end: end)
    }

    /// The last day the cache can speak for.
    public var horizon: DayKey? { DayKey(response.window.end) }

    public var isEmpty: Bool { byId.isEmpty }
    public var count: Int { byId.count }

    public func events(on day: DayKey) -> [ScheduleEvent] { byDay[day] ?? [] }

    public func event(id: String) -> ScheduleEvent? { byId[id] }

    /// The distinct types on a day in display order, for the week strip's dots.
    public func typeDots(on day: DayKey, max: Int = 3) -> [WorkoutType] {
        var seen: [WorkoutType] = []
        for event in events(on: day) where !seen.contains(event.type) {
            seen.append(event.type)
            if seen.count == max { break }
        }
        return seen
    }

    /// The optimistic flip: the same window with one stub's completion changed.
    /// Returns a new index (and, through `response`, the JSON to write back to
    /// the cache so an offline relaunch shows the flip).
    public func settingCompletion(id: String, isCompleted: Bool, completedAt: String?) -> ScheduleIndex {
        let occurrences = response.occurrences.map { stub -> Occurrence in
            guard stub.id == id else { return stub }
            return Occurrence(
                id: stub.id, baseId: stub.baseId, date: stub.date,
                startTime: stub.startTime, endTime: stub.endTime,
                isCompleted: isCompleted, completedAt: isCompleted ? completedAt : nil
            )
        }
        return ScheduleIndex(ScheduleResponse(
            window: response.window, bases: response.bases, occurrences: occurrences,
            definitions: response.definitions, templates: response.templates
        ))
    }
}

/// Layout math for the Month grid. `firstWeekday` follows `Calendar`
/// (1 = Sunday, 2 = Monday); the web is Monday-first, the phone follows the
/// device's calendar.
public enum MonthGrid {
    /// Cells row-major, seven per row, `nil` for the leading and trailing
    /// padding, always a whole number of rows.
    public static func cells(year: Int, month: Int, firstWeekday: Int = 2) -> [DayKey?] {
        let first = DayKey(year: year, month: month, day: 1)
        let leading = (first.weekday - firstWeekday + 7) % 7
        let count = DayKey.daysInMonth(year: year, month: month)
        var cells: [DayKey?] = Array(repeating: nil, count: leading)
        cells += (1...count).map { DayKey(year: year, month: month, day: $0) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    /// Weekday header letters starting from `firstWeekday`.
    public static func weekdayLetters(firstWeekday: Int = 2) -> [String] {
        (0..<7).map { MonthNames.weekdayLetters[(firstWeekday - 1 + $0) % 7] }
    }

    public static func title(year: Int, month: Int) -> String {
        "\(MonthNames.long[month - 1]) \(year)"
    }

    public static func step(year: Int, month: Int, by delta: Int) -> (year: Int, month: Int) {
        let zero = year * 12 + (month - 1) + delta
        return (zero / 12, zero % 12 + 1)
    }
}

/// The seven days of the week containing `day`, for the paging week strip.
public enum WeekPage {
    public static func days(containing day: DayKey, firstWeekday: Int = 2) -> [DayKey] {
        let back = (day.weekday - firstWeekday + 7) % 7
        let start = day.adding(days: -back)
        return (0..<7).map { start.adding(days: $0) }
    }
}
