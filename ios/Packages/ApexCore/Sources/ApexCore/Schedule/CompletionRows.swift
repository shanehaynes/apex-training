import Foundation

/// The two rows `POST /api/completions` takes, keyed by occurrence id. The
/// field sets are the server's allowlists (`COMPLETION_COLUMNS` /
/// `COMPLETION_LOG_COLUMNS` in `api/_lib/allowlist.ts`); `updated_at` is
/// server-stamped and not sent. Mirrors `buildCompletionRows` in
/// `src/lib/schedule/mapping.ts`.
public struct CompletionRow: Codable, Sendable, Equatable {
    public let eventId: String
    public let eventDate: String
    public let eventType: String
    public let eventTitle: String
    public let durationMinutes: Int?
    public let isCompleted: Bool
    public let completedAt: String?

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case eventDate = "event_date"
        case eventType = "event_type"
        case eventTitle = "event_title"
        case durationMinutes = "duration_minutes"
        case isCompleted = "is_completed"
        case completedAt = "completed_at"
    }

    /// Optional fields encode as explicit `null`, matching the web's rows.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(eventId, forKey: .eventId)
        try c.encode(eventDate, forKey: .eventDate)
        try c.encode(eventType, forKey: .eventType)
        try c.encode(eventTitle, forKey: .eventTitle)
        try c.encode(durationMinutes, forKey: .durationMinutes)
        try c.encode(isCompleted, forKey: .isCompleted)
        try c.encode(completedAt, forKey: .completedAt)
    }
}

public struct CompletionLogRow: Codable, Sendable, Equatable {
    public let eventId: String
    public let eventDate: String
    public let eventType: String
    public let eventTitle: String
    public let durationMinutes: Int?
    /// `"complete"` or `"uncomplete"` — anything else is a 400.
    public let action: String

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case eventDate = "event_date"
        case eventType = "event_type"
        case eventTitle = "event_title"
        case durationMinutes = "duration_minutes"
        case action
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(eventId, forKey: .eventId)
        try c.encode(eventDate, forKey: .eventDate)
        try c.encode(eventType, forKey: .eventType)
        try c.encode(eventTitle, forKey: .eventTitle)
        try c.encode(durationMinutes, forKey: .durationMinutes)
        try c.encode(action, forKey: .action)
    }
}

public enum CompletionRows {
    public static func build(for event: ScheduleEvent, isNowCompleted: Bool, now: Date)
        -> (completionRow: CompletionRow, logRow: CompletionLogRow) {
        let completionRow = CompletionRow(
            eventId: event.id,
            eventDate: event.date,
            eventType: event.type.rawValue,
            eventTitle: event.title,
            durationMinutes: event.estimatedDuration,
            isCompleted: isNowCompleted,
            completedAt: isNowCompleted ? isoTimestamp(now) : nil
        )
        let logRow = CompletionLogRow(
            eventId: event.id,
            eventDate: event.date,
            eventType: event.type.rawValue,
            eventTitle: event.title,
            durationMinutes: event.estimatedDuration,
            action: isNowCompleted ? "complete" : "uncomplete"
        )
        return (completionRow, logRow)
    }

    /// JavaScript's `toISOString()` shape — `2026-09-08T18:30:00.000Z` — which
    /// is what every other row in `workout_completions` carries.
    public static func isoTimestamp(_ date: Date) -> String {
        let parts = DayKey.utc.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: date)
        let millis = (parts.nanosecond ?? 0) / 1_000_000
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                      parts.year!, parts.month!, parts.day!, parts.hour!, parts.minute!, parts.second!, millis)
    }
}
