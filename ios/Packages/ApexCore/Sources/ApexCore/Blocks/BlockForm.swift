import Foundation

/// The block editor's value type: what the form holds while the user types,
/// and the insert row it becomes. The Monday/Sunday snapping is the web
/// editor's own component code (`BlockEditor.tsx`, no `__tests__`), so it
/// may live here; week counts and the current week are NOT computed — the
/// server sends both (D-008).
///
/// The stored end is exclusive (the Monday after the last week); the form
/// shows and edits the inclusive Sunday, as the web does.
public struct BlockForm: Sendable, Equatable {
    public var name = ""
    public var intent = ""
    public var phase: String?
    public var objectiveId: String?
    /// Any day; the row carries the Monday of its week.
    public var startDay: DayKey
    /// Any day; the row carries the Monday after the Sunday of its week.
    public var endInclusive: DayKey

    // Targets as typed. Blank means "derive from the calendar" and is omitted
    // from the row, which is how the server knows to derive it.
    public var cardioMinutes = ""
    public var strengthSessions = ""
    public var climbingSessions = ""
    public var longSessionMinutes = ""
    public var vert = ""
    public var vertUnit = "ft"
    public var distance = ""
    public var distanceUnit = "mi"

    public init(startDay: DayKey, endInclusive: DayKey) {
        self.startDay = startDay
        self.endInclusive = endInclusive
    }

    /// The editor opened on an existing block.
    public init(block: BlockSummary) {
        name = block.name
        intent = block.intent
        phase = block.phase
        objectiveId = block.objectiveId
        startDay = DayKey(block.startDate) ?? DayKey(year: 2026, month: 1, day: 5)
        endInclusive = (DayKey(block.endDateExclusive) ?? startDay.adding(days: 7)).adding(days: -1)
        let t = block.weeklyTargets
        cardioMinutes = BlockForm.text(t.cardioMinutes)
        strengthSessions = BlockForm.text(t.strengthSessions)
        climbingSessions = BlockForm.text(t.climbingSessions)
        longSessionMinutes = BlockForm.text(t.longSessionMinutes)
        vert = BlockForm.text(t.vert?.value)
        vertUnit = t.vert?.unit ?? "ft"
        distance = BlockForm.text(t.distance?.value)
        distanceUnit = t.distance?.unit ?? "mi"
    }

    /// A four-week block starting the Monday of `today`'s week.
    public static func new(today: DayKey) -> BlockForm {
        let monday = BlockDates.mondayOf(today)
        return BlockForm(startDay: monday, endInclusive: monday.adding(days: 27))
    }

    public var snappedStart: DayKey { BlockDates.mondayOf(startDay) }
    public var snappedEndExclusive: DayKey { BlockDates.sundayOf(endInclusive).adding(days: 1) }

    /// Save is possible with a name; everything else the server judges.
    public var canSave: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The `weekly_targets` JSONB: blank fields omitted, quantities with their unit.
    public func weeklyTargets() -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if let n = BlockForm.number(cardioMinutes) { out["cardioMinutes"] = .number(n) }
        if let n = BlockForm.number(strengthSessions) { out["strengthSessions"] = .number(n) }
        if let n = BlockForm.number(climbingSessions) { out["climbingSessions"] = .number(n) }
        if let n = BlockForm.number(longSessionMinutes) { out["longSessionMinutes"] = .number(n) }
        if let n = BlockForm.number(vert) { out["vert"] = .object(["value": .number(n), "unit": .string(vertUnit)]) }
        if let n = BlockForm.number(distance) { out["distance"] = .object(["value": .number(n), "unit": .string(distanceUnit)]) }
        return out
    }

    /// The typed targets as the preview spec carries them.
    public func weeklyTargetsValue() -> WeeklyTargets {
        WeeklyTargets(
            cardioMinutes: BlockForm.number(cardioMinutes),
            vert: BlockForm.number(vert).map { .init(value: $0, unit: vertUnit) },
            distance: BlockForm.number(distance).map { .init(value: $0, unit: distanceUnit) },
            strengthSessions: BlockForm.number(strengthSessions),
            climbingSessions: BlockForm.number(climbingSessions),
            longSessionMinutes: BlockForm.number(longSessionMinutes)
        )
    }

    /// The full row `POST /api/blocks` inserts, and the whole-form `fields`
    /// a PATCH sends: every column, with explicit nulls for a cleared phase
    /// or objective (an omitted key would leave the old value in place).
    public func row() -> [String: JSONValue] {
        [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "intent": .string(intent.trimmingCharacters(in: .whitespacesAndNewlines)),
            "phase": phase.map(JSONValue.string) ?? .null,
            "objective_id": objectiveId.map(JSONValue.string) ?? .null,
            "start_date": .string(snappedStart.string),
            "end_date_exclusive": .string(snappedEndExclusive.string),
            "weekly_targets": .object(weeklyTargets()),
        ]
    }

    /// `numberOrUndefined` in BlockEditor.tsx: blank → none; else a finite
    /// number of at least zero, or none.
    static func number(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let n = Double(trimmed), n.isFinite, n >= 0 else { return nil }
        return n
    }

    static func text(_ value: Double?) -> String {
        guard let value else { return "" }
        return value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }
}

/// ISO-week snapping on `DayKey` (`weekday` is 1 = Sunday … 7 = Saturday).
public enum BlockDates {
    /// The Monday of the ISO week containing `day` (`startOfISOWeek`).
    public static func mondayOf(_ day: DayKey) -> DayKey {
        day.adding(days: -((day.weekday + 5) % 7))
    }

    /// The Sunday ending the ISO week containing `day`.
    public static func sundayOf(_ day: DayKey) -> DayKey {
        day.adding(days: (8 - day.weekday) % 7)
    }
}
