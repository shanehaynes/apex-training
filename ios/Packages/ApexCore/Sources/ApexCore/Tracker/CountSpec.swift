import Foundation

/// Side conventions in a count string ("10 each leg", "90 sec/side") — ported
/// from src/lib/schedule/definitions.ts with its test vectors (D-024). Display
/// lifts the convention off the prescription line and shows it once with the
/// notes; the per-side warning after a swap checks that reps state one.
public enum CountSpec {
    /// Whether a count string states its side convention ("5 each leg", "10 total").
    private static let perSide = try! NSRegularExpression( // swiftlint:disable:this force_try
        pattern: #"\beach\b|\bper\s+(side|leg|arm)\b|\btotal\b"#, options: [.caseInsensitive]
    )

    /// Deliberately broader than `perSide` — it only decides where a written
    /// convention is shown, so it also catches "/side" and "fwd/back".
    private static let countSpec = try! NSRegularExpression( // swiftlint:disable:this force_try
        pattern: #"(?:,\s*)?\s*(?:\beach\s+(side|leg|arm|hand)\b|\bper\s+(side|leg|arm|hand)\b|/\s*(side|leg|arm|hand)\b|\bfwd\s*/\s*back\b)"#,
        options: [.caseInsensitive]
    )

    private static let specNote: [String: String] = [
        "side": "Each side.", "leg": "Each leg.", "arm": "Each arm.", "hand": "Each hand.",
    ]

    public static func hasPerSideCount(_ text: String?) -> Bool {
        guard let text, !text.isEmpty else { return false }
        return perSide.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// The count with its convention removed: "90 sec/side" → "90 sec",
    /// "10 each side, light" → "10, light". Untouched when it states none, and
    /// never empty (a count that is only its convention keeps its text).
    public static func stripCountSpec(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return text }
        let ns = NSMutableString(string: text)
        countSpec.replaceMatches(in: ns, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        var stripped = String(ns)
        stripped = stripped.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        stripped = stripped.replacingOccurrences(of: #"^[,\s]+"#, with: "", options: .regularExpression)
        stripped = stripped.trimmingCharacters(in: .whitespaces)
        return stripped.isEmpty ? text : stripped
    }

    /// The conventions stated across reps and duration, as one sentence for the
    /// notes line ("Each side."). Nil when neither states one; deduplicated.
    public static func countSpecNote(reps: String?, duration: String?) -> String? {
        var notes: [String] = []
        for text in [reps, duration] {
            guard let text, !text.isEmpty else { continue }
            let nsText = text as NSString
            for match in countSpec.matches(in: text, range: NSRange(location: 0, length: nsText.length)) {
                var part: String?
                for group in 1...3 {
                    let range = match.range(at: group)
                    if range.location != NSNotFound {
                        part = nsText.substring(with: range).lowercased()
                        break
                    }
                }
                let note = part.flatMap { specNote[$0] } ?? "Forward and back."
                if !notes.contains(note) { notes.append(note) }
            }
        }
        return notes.isEmpty ? nil : notes.joined(separator: " ")
    }

    /// The prescription line for a planned set (`plannedLabel`): "185lb × 5",
    /// with side conventions lifted out; "—" when nothing was planned.
    public static func plannedLabel(_ planned: PlannedSet?) -> String {
        guard let planned else { return "—" }
        var parts: [String] = []
        if let weight = planned.targetWeight, !weight.isEmpty { parts.append(weight) }
        if let reps = stripCountSpec(planned.targetReps), !reps.isEmpty { parts.append("× \(reps)") }
        if let duration = stripCountSpec(planned.targetDuration), !duration.isEmpty { parts.append(duration) }
        return parts.isEmpty ? "—" : parts.joined(separator: " ")
    }
}
