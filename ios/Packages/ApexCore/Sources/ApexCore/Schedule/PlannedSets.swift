import Foundation

/// `src/lib/builder/plannedSets.ts`, ported with its test vectors: the pure
/// half of the exercise editor's "Per-set targets" disclosure. Targets are
/// free text ("~35 lbs", "4–6", "90 sec/side") because that is what the
/// prescription fields and the tracker take; the presets read the leading
/// number out of a target, do their arithmetic, and write it back wearing
/// the same unit. Form state only — the server stores whatever rows the
/// editor sends, and the tracker still synthesises uniform rows for an
/// exercise without any.
///
/// A row holds overrides only: an empty cell follows the set-level field, so
/// editing the base reaches every set that has not said otherwise. The
/// server's `resolvePlannedSets` fills the same way for the tracker.
public enum PlannedSets {
    /// A column of the table, named after the `PlannedSet` field it edits, in
    /// the order the table shows them.
    public enum Field: String, CaseIterable, Sendable, Hashable {
        case weight = "targetWeight"
        case reps = "targetReps"
        case duration = "targetDuration"
        case rest = "targetRest"

        public var label: String {
            switch self {
            case .weight: "Weight"
            case .reps: "Reps"
            case .duration: "Duration"
            case .rest: "Rest"
            }
        }

        /// The set-level prescription field this column overrides.
        public func base(of entry: Exercise) -> String? {
            switch self {
            case .weight: entry.weight
            case .reps: entry.reps
            case .duration: entry.duration
            case .rest: entry.restPeriod
            }
        }

        public func value(of row: PlannedSet) -> String? {
            switch self {
            case .weight: row.targetWeight
            case .reps: row.targetReps
            case .duration: row.targetDuration
            case .rest: row.targetRest
            }
        }

        /// Plate math for weight, whole units for everything else (`stepFor`).
        public var step: Double { self == .weight ? 2.5 : 1 }
    }

    /// `targetFields`: every dimension the base prescription or any authored
    /// row names, plus any added by hand, in table order; weight + reps when
    /// nothing is named.
    public static func fields(for entry: Exercise, adding added: Set<Field> = []) -> [Field] {
        let rows = entry.plannedSets ?? []
        let named = Field.allCases.filter { field in
            !(field.base(of: entry) ?? "").isEmpty || rows.contains { !(field.value(of: $0) ?? "").isEmpty }
        }
        let shown = named.isEmpty ? [Field.weight, .reps] : named
        return Field.allCases.filter { shown.contains($0) || added.contains($0) }
    }

    /// `addableFields`: the columns the table does not show yet.
    public static func addable(_ shown: [Field]) -> [Field] {
        Field.allCases.filter { !shown.contains($0) }
    }

    /// `inheritedTarget`: what an empty cell resolves to — the set-level value.
    public static func inherited(_ entry: Exercise, _ field: Field) -> String? {
        guard let value = field.base(of: entry), !value.isEmpty else { return nil }
        return value
    }

    /// `resolvePlannedSets` for display (the event sheet): each authored row
    /// with the weight, reps and duration it leaves empty filled from the
    /// exercise. Rest stays an override (`rest(for:of:)` falls back). Nil
    /// without authored rows.
    public static func resolved(for entry: Exercise) -> [PlannedSet]? {
        guard let rows = entry.plannedSets, !rows.isEmpty else { return nil }
        return rows.map { source in
            row(
                source.setNumber,
                weight: nonEmpty(source.targetWeight) ?? entry.weight,
                reps: nonEmpty(source.targetReps) ?? entry.reps,
                duration: nonEmpty(source.targetDuration) ?? entry.duration,
                rest: source.targetRest
            )
        }
    }

    /// `setCount`: `sets` when stated, else the authored rows, else 1.
    public static func count(for entry: Exercise) -> Int {
        if let sets = entry.sets, sets > 0 { return sets }
        let authored = entry.plannedSets?.count ?? 0
        return authored > 0 ? authored : 1
    }

    /// `blankSets`: one row per set with no overrides — every set follows the base.
    public static func blank(_ count: Int) -> [PlannedSet] {
        (1...max(1, count)).map { PlannedSet(setNumber: $0) }
    }

    /// `resizeSets`: existing rows stay, rows past the count go, new rows
    /// repeat the last one (or follow the base when there is nothing to repeat).
    public static func resize(_ rows: [PlannedSet], to count: Int) -> [PlannedSet] {
        (0..<max(1, count)).map { index in
            let source = index < rows.count ? rows[index] : rows.last ?? PlannedSet(setNumber: index + 1)
            return row(index + 1, like: source)
        }
    }

    /// `tableRows`: the authored rows at the current count, else blank rows that follow the base.
    public static func tableRows(for entry: Exercise) -> [PlannedSet] {
        let count = count(for: entry)
        if let rows = entry.plannedSets, !rows.isEmpty { return resize(rows, to: count) }
        return blank(count)
    }

    /// `setTarget`: one cell edited; empty text clears the override.
    public static func setting(_ rows: [PlannedSet], setNumber: Int, field: Field, to value: String) -> [PlannedSet] {
        rows.map { existing in
            guard existing.setNumber == setNumber else { return existing }
            return row(existing.setNumber, like: existing, field: field, value: value.trimmingCharacters(in: .whitespaces))
        }
    }

    /// `storedSets`: the rows while any overrides something, else nil — blank
    /// rows plan exactly what the base does.
    public static func stored(_ rows: [PlannedSet]) -> [PlannedSet]? {
        let overrides = rows.contains { candidate in
            Field.allCases.contains { !($0.value(of: candidate) ?? "").isEmpty }
        }
        return overrides ? rows : nil
    }

    /// `withPrescriptionPatch` for the one field that matters: a new set
    /// count resizes authored rows; any other prescription edit leaves them.
    public static func settingSets(_ entry: Exercise, to sets: Int?) -> Exercise {
        var next = entry
        next.sets = sets
        if let rows = entry.plannedSets, !rows.isEmpty {
            next.plannedSets = resize(rows, to: count(for: next))
        }
        return next
    }

    // MARK: - Rest (`src/lib/tracking/rest.ts`)

    /// `restFor`: the set's own rest when it overrides the exercise, else the
    /// exercise's `restPeriod`.
    public static func rest(for planned: PlannedSet?, restPeriod: String?) -> String? {
        nonEmpty(planned?.targetRest?.trimmingCharacters(in: .whitespaces))
            ?? nonEmpty(restPeriod?.trimmingCharacters(in: .whitespaces))
    }

    /// `restSummary`: one value when every set rests the same ("90s"); runs in
    /// set order when they differ ("2 min ×3 · 90s"), a set with no rest as
    /// "none"; nil when nothing rests. The athlete's own text, never recomputed.
    public static func restSummary(_ rests: [String?]) -> String? {
        let values = rests.map { $0?.trimmingCharacters(in: .whitespaces) ?? "" }
        guard values.contains(where: { !$0.isEmpty }) else { return nil }
        var runs: [(value: String, count: Int)] = []
        for value in values {
            if let last = runs.last, last.value == value {
                runs[runs.count - 1].count += 1
            } else {
                runs.append((value: value, count: 1))
            }
        }
        if runs.count == 1 { return runs[0].value }
        return runs.map { run in
            (run.value.isEmpty ? "none" : run.value) + (run.count > 1 ? " ×\(run.count)" : "")
        }.joined(separator: " · ")
    }

    /// `restLine`: a tracker card's rest line, over its planned (non-extra)
    /// sets; the exercise's own rest when none are planned (cardio).
    public static func restLine(restPeriod: String?, sets: [TrackedSet]) -> String? {
        let planned = sets.filter { !$0.isExtra }
        if planned.isEmpty { return nonEmpty(restPeriod?.trimmingCharacters(in: .whitespaces)) }
        return restSummary(planned.map { rest(for: $0.planned, restPeriod: restPeriod) })
    }

    // MARK: - Numbers inside free text

    public struct ParsedTarget: Equatable, Sendable {
        public let value: Double
        /// Text before the number ("~", "BW + ").
        public let prefix: String
        /// Text after it (" lbs", "–6", " sec/side").
        public let suffix: String

        public init(value: Double, prefix: String, suffix: String) {
            self.value = value
            self.prefix = prefix
            self.suffix = suffix
        }
    }

    private static let number = try! NSRegularExpression(pattern: #"-?\d+(?:\.\d+)?"#) // swiftlint:disable:this force_try
    /// A suffix that is only a unit ("lbs", " kg", "s", "%") and can follow any number.
    private static let unitSuffix = try! NSRegularExpression(pattern: #"^\s*[a-zA-Z%]+\.?$"#) // swiftlint:disable:this force_try

    /// `parseTarget`: the first number in a target and the text around it.
    public static func parse(_ text: String?) -> ParsedTarget? {
        guard let text, !text.isEmpty else { return nil }
        let ns = text as NSString
        guard let match = number.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              let value = Double(ns.substring(with: match.range)) else { return nil }
        return ParsedTarget(
            value: value,
            prefix: ns.substring(to: match.range.location),
            suffix: ns.substring(from: match.range.location + match.range.length)
        )
    }

    /// `unitFor`: whatever the user typed after the number, else the base
    /// target's unit when it has a plain one ("~35 lbs" → " lbs"; "4–6" nothing).
    public static func unit(typed: String, base: String?) -> String {
        if let own = parse(typed), !own.suffix.trimmingCharacters(in: .whitespaces).isEmpty { return own.suffix }
        if let inherited = parse(base),
           unitSuffix.firstMatch(in: inherited.suffix, range: NSRange(location: 0, length: (inherited.suffix as NSString).length)) != nil {
            return inherited.suffix
        }
        return ""
    }

    /// `formatNumber`: 147.5 → "147.5", 150 → "150" — no trailing zeros or float noise.
    public static func format(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded(), abs(rounded) < Double(Int.max) { return String(Int(rounded)) }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    private static func snap(_ value: Double, step: Double) -> Double {
        (value / step).rounded() * step
    }

    // MARK: - Presets

    /// `rampSets`: linear from `first` on set 1 to `last` on the final set;
    /// one set gets `first`. Only `field` changes.
    public static func ramp(
        _ rows: [PlannedSet], field: Field, first: Double, last: Double, step: Double? = nil, unit: String = ""
    ) -> [PlannedSet] {
        let step = step ?? field.step
        let n = rows.count
        return rows.enumerated().map { index, existing in
            let t = n > 1 ? Double(index) / Double(n - 1) : 0
            return row(existing.setNumber, like: existing, field: field, value: format(snap(first + (last - first) * t, step: step)) + unit)
        }
    }

    /// `pyramidSets`: up to `peak` in the middle and back down to `low`; an
    /// even count's two middle sets share the climb's upper value.
    public static func pyramid(
        _ rows: [PlannedSet], field: Field, low: Double, peak: Double, step: Double? = nil, unit: String = ""
    ) -> [PlannedSet] {
        let step = step ?? field.step
        let centre = Double(rows.count - 1) / 2
        return rows.enumerated().map { index, existing in
            let t = centre > 0 ? 1 - abs(Double(index) - centre) / centre : 1
            return row(existing.setNumber, like: existing, field: field, value: format(snap(low + (peak - low) * t, step: step)) + unit)
        }
    }

    /// `topSetBackoffs`: the top on the leading sets and `backoffs` trailing
    /// sets at `percent` of it; at least one top set always remains.
    public static func topSetBackoffs(
        _ rows: [PlannedSet], field: Field, top: Double, backoffs: Int, percent: Double, step: Double? = nil, unit: String = ""
    ) -> [PlannedSet] {
        let step = step ?? field.step
        let n = rows.count
        let trailing = min(max(0, backoffs), max(0, n - 1))
        let backoff = snap(top * (percent / 100), step: step)
        return rows.enumerated().map { index, existing in
            let value = index >= n - trailing ? backoff : snap(top, step: step)
            return row(existing.setNumber, like: existing, field: field, value: format(value) + unit)
        }
    }

    // MARK: - Rows

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    /// A row with only the fields that carry a value (`PlannedSet`'s fields are `let`).
    private static func row(_ setNumber: Int, weight: String?, reps: String?, duration: String?, rest: String?) -> PlannedSet {
        PlannedSet(
            setNumber: setNumber,
            targetWeight: nonEmpty(weight),
            targetReps: nonEmpty(reps),
            targetDuration: nonEmpty(duration),
            targetRest: nonEmpty(rest)
        )
    }

    private static func row(_ setNumber: Int, like source: PlannedSet, field: Field? = nil, value: String? = nil) -> PlannedSet {
        row(
            setNumber,
            weight: field == .weight ? value : source.targetWeight,
            reps: field == .reps ? value : source.targetReps,
            duration: field == .duration ? value : source.targetDuration,
            rest: field == .rest ? value : source.targetRest
        )
    }
}
