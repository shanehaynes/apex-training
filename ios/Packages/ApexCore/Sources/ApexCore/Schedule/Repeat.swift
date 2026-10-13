import Foundation

/// The builder's repeat model — `src/lib/builder/repeat.ts`, ported with its
/// test vectors (D-027; D-008 names "repeat chips" as Swift-owned UI state).
/// Weekly (day-of-week chips, every N weeks) or daily (every N days), ending
/// never, on a date, or after N times: the subset of the recurrence engine
/// the builder authors. Rules the picker cannot express (MONTHLY, weekly
/// without BYDAY, anything unparseable) survive round-trips verbatim through
/// `custom` and are never rewritten. Expansion itself stays on the server.
public enum Weekday: String, Codable, Sendable, CaseIterable, Hashable {
    case sunday = "SU", monday = "MO", tuesday = "TU", wednesday = "WE", thursday = "TH", friday = "FR", saturday = "SA"

    /// The engine's canonical SU-first order (`WEEKDAYS` in `recurrence/types.ts`).
    public static let canonical: [Weekday] = [.sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday]
    /// Chip order — training weeks start Monday (`REPEAT_DAY_ORDER`).
    public static let chipOrder: [Weekday] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]

    /// `REPEAT_DAY_LABELS`: one letter per chip.
    public var label: String {
        switch self {
        case .monday: "M"
        case .tuesday, .thursday: "T"
        case .wednesday: "W"
        case .friday: "F"
        case .saturday, .sunday: "S"
        }
    }

    /// From `Calendar`'s 1 = Sunday … 7 = Saturday.
    public init(calendarWeekday: Int) {
        self = Weekday.canonical[(calendarWeekday - 1 + 7) % 7]
    }
}

/// `RepeatFreq`: the two frequencies the picker authors.
public enum RepeatFrequency: String, Codable, Sendable {
    case weekly = "WEEKLY"
    case daily = "DAILY"
}

/// `DraftRepeat`. Numeric input is a string, like every numeric draft field:
/// an input must be clearable. `until` is `YYYY-MM-DD` inclusive, `""` = never.
public struct DraftRepeat: Codable, Sendable, Equatable {
    public var enabled: Bool
    /// Absent = weekly, so a draft that predates daily rules keeps its shape
    /// on the wire (the server reads a missing `freq` the same way).
    public var freq: RepeatFrequency?
    /// Weekly only; a daily rule ignores them.
    public var days: [Weekday]
    public var interval: String
    public var until: String
    /// "After N times", the anchor included; nil or `""` = no count.
    /// Exclusive with `until` — the picker clears one when the other is set.
    public var count: String?
    /// A rule the picker can't express — kept verbatim, saved untouched.
    public var custom: String?

    public init(
        enabled: Bool, days: [Weekday], interval: String, until: String, custom: String? = nil,
        freq: RepeatFrequency? = nil, count: String? = nil
    ) {
        self.enabled = enabled
        self.freq = freq
        self.days = days
        self.interval = interval
        self.until = until
        self.count = count
        self.custom = custom
    }

    /// `repeatFreq`: the frequency, weekly when unset.
    public var frequency: RepeatFrequency { freq ?? .weekly }
    /// The count as typed, `""` when unset.
    public var countText: String { count ?? "" }

    /// `REPEAT_OFF`.
    public static let off = DraftRepeat(enabled: false, days: [], interval: "1", until: "")
}

public enum Repeat {
    /// `repeatFromRule`: no rule → off; an expressible weekly or daily rule →
    /// the picker state; anything else → enabled with the rule kept verbatim
    /// as `custom`. `freq` and `count` stay nil at their defaults so a weekly,
    /// count-less rule reads back as exactly the shape older clients produce.
    public static func fromRule(_ rule: String?) -> DraftRepeat {
        guard let rule, !rule.isEmpty else { return .off }
        if let parsed = RRule.parse(rule) {
            let count = parsed.count.map(String.init)
            if parsed.freq == "WEEKLY", !parsed.byDay.isEmpty {
                return DraftRepeat(enabled: true, days: parsed.byDay, interval: String(parsed.interval), until: parsed.until ?? "", count: count)
            }
            if parsed.freq == "DAILY", parsed.byDay.isEmpty {
                return DraftRepeat(enabled: true, days: [], interval: String(parsed.interval), until: parsed.until ?? "", freq: .daily, count: count)
            }
        }
        var custom = DraftRepeat.off
        custom.enabled = true
        custom.custom = rule
        return custom
    }

    /// `ruleFromRepeat`: the canonical RRULE value for the picker state; nil
    /// when off. Never fails: a bad interval falls back to 1, a bad count is
    /// dropped, and when both ends are set the date wins — `problem` is where
    /// a user hears about any of that.
    public static func rule(from state: DraftRepeat) -> String? {
        guard state.enabled else { return nil }
        if let custom = state.custom { return custom }
        let freq = state.frequency
        if freq == .weekly, state.days.isEmpty { return nil }
        let interval = Int(state.interval.trimmingCharacters(in: .whitespaces)).map { $0 >= 1 ? $0 : 1 } ?? 1
        let days = freq == .weekly
            ? state.days.sorted { Weekday.canonical.firstIndex(of: $0)! < Weekday.canonical.firstIndex(of: $1)! }
            : []
        let count = state.until.isEmpty ? parsedCount(state) : nil
        return RRule.serialize(freq: freq, interval: interval, byDay: days, count: count, until: state.until.isEmpty ? nil : state.until)
    }

    /// The count when it is a positive integer, else nil.
    private static func parsedCount(_ state: DraftRepeat) -> Int? {
        let text = state.countText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text.allSatisfy(\.isNumber), let n = Int(text), n >= 1 else { return nil }
        return n
    }

    /// `snapAnchorDate`: move the anchor forward (at most six days) to the
    /// first selected weekday. The engine renders the anchor row at its own
    /// date and generates dates strictly after it — an anchor on an unselected
    /// weekday would put a stray occurrence on a day the user never picked.
    public static func snapAnchorDate(_ date: String, days: [Weekday]) -> String {
        guard !days.isEmpty, var candidate = DayKey(date) else { return date }
        for _ in 0..<7 {
            if days.contains(Weekday(calendarWeekday: candidate.weekday)) { return candidate.string }
            candidate = candidate.adding(days: 1)
        }
        return date
    }

    /// `repeatProblem`: the first user-facing validation problem, or nil.
    public static func problem(_ state: DraftRepeat, anchorDate: String) -> String? {
        guard state.enabled, state.custom == nil else { return nil }
        let freq = state.frequency
        if freq == .weekly, state.days.isEmpty { return "Pick at least one day to repeat on" }
        guard let interval = Int(state.interval.trimmingCharacters(in: .whitespaces)), interval >= 1 else {
            return "Repeat interval must be at least 1"
        }
        if !state.countText.trimmingCharacters(in: .whitespaces).isEmpty {
            if parsedCount(state) == nil { return "Repeat count must be at least 1" }
            if !state.until.isEmpty { return "Choose an end date or a number of times, not both" }
        }
        if !state.until.isEmpty, state.until < snapAnchorDate(anchorDate, days: freq == .weekly ? state.days : []) {
            return "The repeat end date is before the first occurrence"
        }
        return nil
    }
}

/// The subset of `src/lib/recurrence/{parse,serialize}.ts` the picker needs.
/// Strict like the web's parser: unknown or duplicate keys, empty values,
/// ordinal BYDAY entries and timestamped UNTILs all read as "not a rule the
/// picker can edit" — the caller keeps the string verbatim as `custom`.
enum RRule {
    struct Parsed {
        var freq: String
        var interval: Int
        var byDay: [Weekday]
        var count: Int?
        var until: String?
    }

    private static let knownKeys: Set<String> = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL"]

    static func parse(_ rule: String) -> Parsed? {
        var seen: Set<String> = []
        var parsed = Parsed(freq: "", interval: 1, byDay: [], count: nil, until: nil)
        for part in rule.split(separator: ";", omittingEmptySubsequences: false) {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2 else { return nil }
            let key = String(pair[0]), value = String(pair[1])
            guard knownKeys.contains(key), !seen.contains(key), !value.isEmpty else { return nil }
            seen.insert(key)
            switch key {
            case "FREQ": parsed.freq = value
            case "INTERVAL":
                guard let n = Int(value), n >= 1 else { return nil }
                parsed.interval = n
            case "BYDAY":
                for token in value.split(separator: ",") {
                    guard let day = Weekday(rawValue: String(token)) else { return nil }
                    parsed.byDay.append(day)
                }
            case "COUNT":
                guard let n = Int(value), n >= 1 else { return nil }
                parsed.count = n
            case "UNTIL":
                guard value.count == 8, value.allSatisfy(\.isNumber) else { return nil }
                let y = value.prefix(4), m = value.dropFirst(4).prefix(2), d = value.suffix(2)
                let iso = "\(y)-\(m)-\(d)"
                guard DayKey(iso) != nil else { return nil }
                parsed.until = iso
            default: break
            }
        }
        // The web's validateRRule: COUNT and UNTIL are mutually exclusive.
        guard seen.contains("FREQ"), !(seen.contains("COUNT") && seen.contains("UNTIL")) else { return nil }
        return parsed
    }

    /// `FREQ=…[;INTERVAL=n][;BYDAY=…][;COUNT=n][;UNTIL=YYYYMMDD]` in the
    /// engine's canonical key order — `INTERVAL=1` and an empty BYDAY omitted.
    static func serialize(freq: RepeatFrequency, interval: Int, byDay: [Weekday], count: Int?, until: String?) -> String {
        var parts = ["FREQ=\(freq.rawValue)"]
        if interval > 1 { parts.append("INTERVAL=\(interval)") }
        if !byDay.isEmpty { parts.append("BYDAY=\(byDay.map(\.rawValue).joined(separator: ","))") }
        if let count { parts.append("COUNT=\(count)") }
        if let until { parts.append("UNTIL=\(until.replacingOccurrences(of: "-", with: ""))") }
        return parts.joined(separator: ";")
    }
}
