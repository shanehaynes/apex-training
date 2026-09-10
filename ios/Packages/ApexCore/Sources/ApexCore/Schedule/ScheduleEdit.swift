import Foundation

/// The event sheet's direct edits (W7): what each one sends, and how the
/// index looks while the request is in flight. Pure, so a Linux `swift test`
/// pins the bodies; `ScheduleModel.commit` applies → sends → rolls back on
/// failure, the completion toggle's pattern (D-027: event CRUD is direct,
/// never queued).
public enum ScheduleEdit: Sendable, Equatable {
    case retitle(ScheduleEvent, title: String)
    case setDifficulty(ScheduleEvent, Int)
    /// nil = section unchanged; the web sends only what differs.
    case setSections(ScheduleEvent, warmup: [Exercise]?, exercises: [Exercise]?, cooldown: [Exercise]?)
    /// A one-off moves by PATCH; a recurring occurrence by a per-occurrence
    /// override keyed at `keyDate`, sent as the full date/start/end triple
    /// (the server writes all three columns, and the stub already shows any
    /// earlier override merged in).
    case reschedule(ScheduleEvent, OccurrenceOverride)
    /// A one-off, or a whole series.
    case deleteEvent(ScheduleEvent)
    /// "This day only" on a recurring occurrence.
    case skipOccurrence(ScheduleEvent)

    public var event: ScheduleEvent {
        switch self {
        case .retitle(let e, _), .setDifficulty(let e, _), .setSections(let e, _, _, _),
             .reschedule(let e, _), .deleteEvent(let e), .skipOccurrence(let e):
            e
        }
    }

    public func endpoint() -> Endpoint {
        let event = self.event
        let log = EventMutationLog(eventTitle: event.title, eventDate: event.date)
        switch self {
        case .retitle(_, let title):
            return .updateEvent(id: event.baseId, fields: EventFields(title: title), log: EventMutationLog(eventTitle: title, eventDate: event.date))
        case .setDifficulty(_, let difficulty):
            return .updateEvent(id: event.baseId, fields: EventFields(difficulty: difficulty), log: log)
        case .setSections(_, let warmup, let exercises, let cooldown):
            return .updateEvent(id: event.baseId, fields: EventFields(warmup: warmup, exercises: exercises, cooldown: cooldown), log: log)
        case .reschedule(_, let override):
            if event.isRecurring {
                let full = OccurrenceOverride(
                    date: override.date ?? event.date,
                    startTime: override.startTime ?? event.startTime,
                    endTime: override.endTime ?? event.endTime
                )
                return .rescheduleInstance(eventId: event.baseId, date: event.keyDate, eventTitle: event.title, overrides: full)
            }
            let fields = EventFields(date: override.date, startTime: override.startTime, endTime: override.endTime)
            return .updateEvent(id: event.baseId, fields: fields, log: EventMutationLog(eventTitle: event.title, eventDate: override.date ?? event.date))
        case .deleteEvent:
            return .deleteEvent(id: event.baseId, log: log)
        case .skipOccurrence:
            return .skipInstance(eventId: event.baseId, date: event.keyDate, eventTitle: event.title)
        }
    }

    /// The optimistic index.
    public func apply(to index: ScheduleIndex) -> ScheduleIndex {
        let event = self.event
        switch self {
        case .retitle(_, let title):
            var base = event.base
            base.title = title
            return index.replacing(base: base)
        case .setDifficulty(_, let difficulty):
            var base = event.base
            base.difficulty = difficulty
            return index.replacing(base: base)
        case .setSections(_, let warmup, let exercises, let cooldown):
            var base = event.base
            if let warmup { base.warmup = warmup }
            if let exercises { base.exercises = exercises }
            if let cooldown { base.cooldown = cooldown }
            return index.replacing(base: base)
        case .reschedule(_, let override):
            if event.isRecurring { return index.rescheduling(occurrenceId: event.id, override) }
            var base = event.base
            if let date = override.date { base.date = date }
            if let start = override.startTime { base.startTime = start }
            if let end = override.endTime { base.endTime = end }
            return index.replacing(base: base).rescheduling(occurrenceId: event.id, override)
        case .deleteEvent:
            return index.removing(baseId: event.baseId)
        case .skipOccurrence:
            return index.removing(occurrenceId: event.id)
        }
    }

    /// The web's toasts.
    public var failureToast: String {
        switch self {
        case .deleteEvent, .skipOccurrence: "Failed to delete — try again"
        default: "Failed to save — try again"
        }
    }
}

/// The allow-listed `workout_events` columns the sheet edits, snake_case as
/// `PATCH /api/events` wants them; nil keys are omitted (`eventFieldsToRow`).
public struct EventFields: Encodable, Sendable, Equatable {
    public var title: String?
    public var difficulty: Int?
    public var date: String?
    public var startTime: String?
    public var endTime: String?
    public var warmup: [Exercise]?
    public var exercises: [Exercise]?
    public var cooldown: [Exercise]?

    public init(
        title: String? = nil, difficulty: Int? = nil, date: String? = nil, startTime: String? = nil, endTime: String? = nil,
        warmup: [Exercise]? = nil, exercises: [Exercise]? = nil, cooldown: [Exercise]? = nil
    ) {
        self.title = title
        self.difficulty = difficulty
        self.date = date
        self.startTime = startTime
        self.endTime = endTime
        self.warmup = warmup
        self.exercises = exercises
        self.cooldown = cooldown
    }

    enum CodingKeys: String, CodingKey {
        case title, difficulty, date, warmup, exercises, cooldown
        case startTime = "start_time"
        case endTime = "end_time"
    }
}

/// `EventMutationLogEntry`: what the audit row says. Always user-attributed
/// from the phone — the coach's writes go through `/api/coach-tool`.
public struct EventMutationLog: Encodable, Sendable, Equatable {
    public var eventTitle: String
    public var eventDate: String?
    public var triggeredBy = "user"

    public init(eventTitle: String, eventDate: String? = nil) {
        self.eventTitle = eventTitle
        self.eventDate = eventDate
    }

    enum CodingKeys: String, CodingKey {
        case eventTitle = "event_title"
        case eventDate = "event_date"
        case triggeredBy = "triggered_by"
    }
}
