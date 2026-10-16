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
    // period. Whole string, case-insensitive. Spelled with explicit classes
    // rather than ICU's `\s`, `\d` and case folding, which reach past what
    // JavaScript's do (a Kelvin sign folds to k, NEL is a space, a BOM is not):
    // `ws` is exactly JS's `\s`, digits are ASCII, letters are ASCII pairs.
    private static let ws = #"[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"#
    private static let grammar: NSRegularExpression = {
        let unit = "[lL][bB][sS]?|[pP][oO][uU][nN][dD][sS]?|#|[kK][gG][sS]?|[kK][iI][lL][oO][sS]?|[kK][iI][lL][oO][gG][rR][aA][mM][sS]?"
        let pattern = #"\A\#(ws)*([bB][wW])?\#(ws)*([+-])?\#(ws)*([0-9]+(?:[.,][0-9]+)?)?\#(ws)*(?:(\#(unit))\.?)?\#(ws)*\z"#
        return try! NSRegularExpression(pattern: pattern)
    }()

    /// JavaScript's `String.prototype.trim` set (`\s` plus the line terminators).
    private static let jsWhitespace: Set<Unicode.Scalar> = Set(
        [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
            .compactMap(Unicode.Scalar.init) + (0x2000...0x200A).compactMap(Unicode.Scalar.init)
    )

    private static func jsTrim(_ text: String) -> Substring.UnicodeScalarView {
        var scalars = Substring(text).unicodeScalars
        while let first = scalars.first, jsWhitespace.contains(first) { scalars.removeFirst() }
        while let last = scalars.last, jsWhitespace.contains(last) { scalars.removeLast() }
        return scalars
    }

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
        guard let text else { return nil }
        var digits = ""
        var seenDot = false
        // Scalar by scalar, as the web's regex reads code units: a digit that
        // carries a combining mark is still a digit.
        for scalar in jsTrim(text) {
            if ("0"..."9").contains(scalar) {
                digits.unicodeScalars.append(scalar)
            } else if scalar == ".", !seenDot, !digits.isEmpty {
                seenDot = true
                digits.unicodeScalars.append(scalar)
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
        // Weights are free text: a pasted twenty-digit entry would overflow
        // Int and trap, so a total no Int holds is no line rather than a crash.
        guard any else { return nil }
        return Int(exactly: lbToUnit(total, ctx.unit).rounded())
    }
}
