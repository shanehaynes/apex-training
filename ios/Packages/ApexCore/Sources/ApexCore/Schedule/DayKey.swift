import Foundation

/// A calendar date with no time and no zone — the `YYYY-MM-DD` the API speaks.
/// Arithmetic runs on a fixed UTC Gregorian calendar so a day is a day
/// regardless of DST; only `today(clock:timeZone:)` looks at a real zone.
public struct DayKey: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// Strict `YYYY-MM-DD`; nil for anything else, including impossible dates.
    public init?(_ string: String) {
        let parts = string.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...DayKey.daysInMonth(year: y, month: m)).contains(d)
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public var string: String { String(format: "%04d-%02d-%02d", year, month, day) }
    public var description: String { string }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let key = DayKey(raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a YYYY-MM-DD date: \(raw)"))
        }
        self = key
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(string)
    }

    public static func < (lhs: DayKey, rhs: DayKey) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    // MARK: - Calendar arithmetic

    static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// Midnight UTC of this day — an arithmetic anchor, never shown to anyone.
    public var utcMidnight: Date {
        DayKey.utc.date(from: DateComponents(year: year, month: month, day: day))!
    }

    public func adding(days: Int) -> DayKey {
        DayKey(DayKey.utc.date(byAdding: .day, value: days, to: utcMidnight)!)
    }

    /// Signed day count from `self` to `other`.
    public func days(until other: DayKey) -> Int {
        DayKey.utc.dateComponents([.day], from: utcMidnight, to: other.utcMidnight).day!
    }

    /// 1 = Sunday … 7 = Saturday, the `Calendar` convention.
    public var weekday: Int { DayKey.utc.component(.weekday, from: utcMidnight) }

    public var monthStart: DayKey { DayKey(year: year, month: month, day: 1) }

    public static func daysInMonth(year: Int, month: Int) -> Int {
        let first = utc.date(from: DateComponents(year: year, month: month, day: 1))!
        return utc.range(of: .day, in: .month, for: first)!.count
    }

    /// The date `now` falls on in `timeZone`.
    public static func today(clock: any ApexClock, timeZone: TimeZone) -> DayKey {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: clock.now)
        return DayKey(year: parts.year!, month: parts.month!, day: parts.day!)
    }

    private init(_ date: Date) {
        let parts = DayKey.utc.dateComponents([.year, .month, .day], from: date)
        self.init(year: parts.year!, month: parts.month!, day: parts.day!)
    }
}

/// English month names, used where a label is built in ApexCore. The UI is
/// free to localise; these keep the core dependency-free and testable.
public enum MonthNames {
    public static let long = ["January", "February", "March", "April", "May", "June", "July",
                              "August", "September", "October", "November", "December"]
    public static let short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    public static let weekdayLetters = ["S", "M", "T", "W", "T", "F", "S"]
    public static let weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    public static let weekdayLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
}

/// Stored event times are display strings: newer rows carry `"17:30"`,
/// older ones `"5:30 PM"`. `src/lib/time.ts` treats both; so does this.
public enum TimeLabel {
    /// Minutes since midnight, or nil when the string is not a time.
    public static func minutes(_ stored: String) -> Int? {
        let trimmed = stored.trimmingCharacters(in: .whitespaces)
        let upper = trimmed.uppercased()
        let isPM = upper.hasSuffix("PM")
        let isAM = upper.hasSuffix("AM")
        var clock = upper
        if isPM || isAM { clock = String(upper.dropLast(2)).trimmingCharacters(in: .whitespaces) }
        let parts = clock.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0...23).contains(h), (0...59).contains(m) else { return nil }
        var hour = h
        if isPM, hour < 12 { hour += 12 }
        if isAM, hour == 12 { hour = 0 }
        return hour * 60 + m
    }

    /// `"17:30"` → `"5:30 PM"`; an already-display string passes through
    /// unchanged; nil and garbage come back as given.
    public static func display(_ stored: String?) -> String? {
        guard let stored, let total = minutes(stored) else { return stored }
        let hour24 = total / 60, minute = total % 60
        let suffix = hour24 >= 12 ? "PM" : "AM"
        var hour12 = hour24 % 12
        if hour12 == 0 { hour12 = 12 }
        return String(format: "%d:%02d %@", hour12, minute, suffix)
    }

    /// `"5:30 PM – 6:30 PM"`, or just the start (`formatEventTime` on the web).
    public static func range(start: String?, end: String?) -> String? {
        guard let start = display(start) else { return nil }
        guard let end = display(end) else { return start }
        return "\(start) – \(end)"
    }

    /// `45m`, `2h`, `1h 30m` (`formatDuration` in `src/utils/dateHelpers.ts`).
    public static func duration(minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        if h == 0 { return "\(m)m" }
        if m == 0 { return "\(h)h" }
        return "\(h)h \(m)m"
    }

    /// `mm:ss` / `h:mm:ss` for stream scrubbing (`formatElapsed` in StreamCharts.tsx).
    public static func elapsed(seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}
