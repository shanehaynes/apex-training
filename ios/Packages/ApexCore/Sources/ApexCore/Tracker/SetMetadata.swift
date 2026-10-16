import Foundation

/// Per-set metadata (phase55, the web's #422 tracker): effort, the warm-up
/// flag, and for a climbing pitch how the ascent went and the goes it took.
/// The parsers are plan.ts's, so a row saved here is the row the web saves.
public enum SetMetadata {
    /// `RPE_MIN` / `RPE_MAX` in plan.ts; the column CHECK is the same range.
    public static let rpeRange: ClosedRange<Double> = 1...10

    /// `parseRpe`: a number in 1–10, rounded to the nearest half; anything
    /// else (blank, out of range, not a number) is no rating. A decimal comma
    /// is read as a point — the keypad types "7,5" in comma locales — which
    /// the web's `Number()` does not do.
    public static func parseRpe(_ text: String?) -> Double? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: ",", with: "."), !trimmed.isEmpty,
              let n = Double(trimmed), n.isFinite, rpeRange.contains(n) else { return nil }
        return (n * 2).rounded() / 2
    }

    /// `normalizeRpeText`: what the field settles to when it is left — the
    /// parsed value ("7.5", "8"), or empty.
    public static func normalizeRpeText(_ text: String) -> String {
        guard let n = parseRpe(text) else { return "" }
        return n == n.rounded() ? String(Int(n)) : String(n)
    }

    /// `parseAttempts`: digits only, at least one go.
    public static func parseAttempts(_ text: String?) -> Int? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespaces), !trimmed.isEmpty,
              trimmed.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(trimmed), n >= 1 else { return nil }
        return n
    }

    /// One `ASCENT_STYLES` entry (src/lib/climbing.ts). The values are the
    /// `workout_set_logs.ascent_style` CHECK's.
    public struct AscentStyle: Equatable, Sendable, Identifiable {
        public let value: String
        public let label: String
        public var id: String { value }
    }

    public static let ascentStyles: [AscentStyle] = [
        AscentStyle(value: "flash", label: "Flashed"),
        AscentStyle(value: "redpoint", label: "Redpointed"),
        AscentStyle(value: "follow", label: "Followed"),
        AscentStyle(value: "attempt", label: "Attempted"),
    ]

    /// `ascentStylesFor`: a boulder problem is never followed.
    public static func ascentStyles(for climbStyle: String?) -> [AscentStyle] {
        climbStyle == "boulder" ? ascentStyles.filter { $0.value != "follow" } : ascentStyles
    }

    public static func ascentLabel(_ value: String?) -> String? {
        ascentStyles.first { $0.value == value }?.label
    }
}
