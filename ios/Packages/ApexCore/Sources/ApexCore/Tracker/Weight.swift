import Foundation

/// One parser for every weight the tracker stores as free text — a port of
/// `src/lib/tracking/weight.ts`, so "62.5 kg", "137 lb", "BW+25" and a bare
/// "80" under a kg profile mean here what they mean on the web. Numbers out of
/// it are always pounds, kept as a float (display rounds).
public enum Weight {
    public enum Unit: String, Sendable, Equatable {
        case lb, kg
    }

    /// `WeightContext`: how the athlete types and reads weights, and the body
    /// weight (pounds, under either unit) that makes "BW" forms resolvable.
    public struct Context: Sendable, Equatable {
        public let unit: Unit
        public let bodyWeightLb: Double?

        public init(unit: Unit, bodyWeightLb: Double?) {
            self.unit = unit
            self.bodyWeightLb = bodyWeightLb
        }

        /// `DEFAULT_WEIGHT_CONTEXT`.
        public static let `default` = Context(unit: .lb, bodyWeightLb: nil)

        /// `weightContextFromProfile`: "kg" or else pounds; a positive body
        /// weight or none.
        public init(profileUnit: String?, bodyWeightLb: Double?) {
            unit = profileUnit == "kg" ? .kg : .lb
            if let body = bodyWeightLb, body.isFinite, body > 0 {
                self.bodyWeightLb = body
            } else {
                self.bodyWeightLb = nil
            }
        }
    }

    public enum Kind: Sendable, Equatable {
        case absolute, bodyweight
    }

    public struct Parsed: Sendable, Equatable {
        public let lb: Double
        public let kind: Kind
    }

    /// `LB_PER_KG`.
    public static let lbPerKg = 2.20462

    // The web's GRAMMAR: an optional BW, an optional sign, an optional number
    // (comma or dot decimal), an optional unit that may carry a trailing
    // period. Whole string, case-insensitive.
    private static let grammar = try! NSRegularExpression(
        pattern: #"^\s*(bw)?\s*([+-])?\s*(\d+(?:[.,]\d+)?)?\s*(?:(lbs?|pounds?|#|kgs?|kilos?|kilograms?)\.?)?\s*$"#,
        options: [.caseInsensitive]
    )

    /// "1,200" is a thousands separator (a comma, exactly three digits,
    /// nothing after); any other comma is a decimal.
    private static func number(_ text: String) -> Double? {
        let parts = text.split(separator: ",", omittingEmptySubsequences: false)
        if parts.count == 2, parts[1].count == 3 { return Double(parts.joined()) }
        return Double(text.replacingOccurrences(of: ",", with: "."))
    }

    private static func toLb(_ value: Double, _ unit: Unit) -> Double {
        unit == .kg ? value * lbPerKg : value
    }

    /// `parseWeight`: the weight a tracker value means, in pounds, or nil —
    /// a sign without BW, "100kg x 5", "80%", a grade, empty. A BW form
    /// resolves only against a positive body weight.
    public static func parse(_ text: String?, _ ctx: Context) -> Parsed? {
        guard let text else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = grammar.firstMatch(in: text, range: range) else { return nil }
        func group(_ i: Int) -> String? {
            let r = match.range(at: i)
            guard r.location != NSNotFound, let swiftRange = Range(r, in: text) else { return nil }
            return String(text[swiftRange])
        }
        let bw = group(1), sign = group(2), digits = group(3), rawUnit = group(4)
        // Every kilogram spelling starts with k; every pound spelling does not.
        let unit: Unit = rawUnit.map { $0.lowercased().hasPrefix("k") ? .kg : .lb } ?? ctx.unit

        guard bw != nil else {
            guard sign == nil, let digits, let value = number(digits) else { return nil }
            let lb = toLb(value, unit)
            return lb.isFinite ? Parsed(lb: lb, kind: .absolute) : nil
        }

        guard let body = ctx.bodyWeightLb, body.isFinite, body > 0 else { return nil }
        // "BW" alone, or "BW±N"; "BW25", "BW+" and "BW kg" are malformed.
        if sign != nil ? digits == nil : (digits != nil || rawUnit != nil) { return nil }
        var load = 0.0
        if sign != nil {
            guard let digits, let value = number(digits) else { return nil }
            load = toLb(value, unit)
        }
        let lb = sign == "-" ? body - load : body + load
        return lb.isFinite && lb > 0 ? Parsed(lb: lb, kind: .bodyweight) : nil
    }

    /// `lbToUnit`: pounds → the display unit. Never rounds.
    public static func lbToUnit(_ lb: Double, _ unit: Unit) -> Double {
        unit == .kg ? lb / lbPerKg : lb
    }

    /// `parseLeadingNumber` (records.ts): the leading "12" or "12.5" of a
    /// reps value like "12 each side".
    public static func leadingNumber(_ text: String?) -> Double? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        var digits = ""
        var seenDot = false
        for c in trimmed {
            if c.isASCII, c.isNumber {
                digits.append(c)
            } else if c == ".", !seenDot, !digits.isEmpty {
                seenDot = true
                digits.append(c)
            } else {
                break
            }
        }
        // "12." is "12" to the web's regex (the dot needs a digit after it).
        if digits.hasSuffix(".") { digits.removeLast() }
        guard !digits.isEmpty, let n = Double(digits), n.isFinite else { return nil }
        return n
    }

    /// Whether a set counts toward any stat (`isPerformedSet`): not a
    /// zero-fill, not a warm-up.
    public static func isPerformed(_ set: TrackedSet) -> Bool {
        !set.isAutofilled && set.isWarmup != true
    }

    /// `sessionTonnage` (WorkoutSummary.tsx): Σ weight × reps over the
    /// session's working sets — a parsed weight above zero and at least one
    /// rep (`classifySet`'s 1RM branch) — read with the profile's context and
    /// given in its unit, to the whole unit. Pitches (a grade in the weight
    /// column) and cardio carry no volume. Nil when no set carried both.
    public static func sessionTonnage(_ groups: [TrackedSectionGroup], _ ctx: Context) -> Int? {
        var total = 0.0
        var any = false
        for group in groups {
            for tracked in group.exercises where !tracked.isCardio && tracked.exercise.category != "climbing" {
                for set in tracked.sets where isPerformed(set) {
                    guard let weight = parse(set.actualWeight, ctx), weight.lb > 0,
                          let reps = leadingNumber(set.actualReps), reps >= 1 else { continue }
                    total += weight.lb * reps
                    any = true
                }
            }
        }
        return any ? Int(lbToUnit(total, ctx.unit).rounded()) : nil
    }
}
