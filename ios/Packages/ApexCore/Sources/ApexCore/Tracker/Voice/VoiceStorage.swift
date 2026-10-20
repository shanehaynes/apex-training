import Foundation

/// The one formatter from spoken values to the text a set row stores — the
/// same text the keyboard would have produced (typed parity, D-059 decision 4).
public enum VoiceStorage {
    /// What goes into each column; nil where nothing was said.
    public struct Text: Equatable, Sendable {
        public var weight: String?
        public var reps: String?
        public var duration: String?
        public var rpe: String?

        public init(weight: String? = nil, reps: String? = nil, duration: String? = nil, rpe: String? = nil) {
            self.weight = weight
            self.reps = reps
            self.duration = duration
            self.rpe = rpe
        }

        public subscript(field: SetField) -> String? {
            switch field {
            case .weight: weight
            case .reps: reps
            case .duration: duration
            }
        }
    }

    /// `unit` is the profile's: a weight spoken without one is stored bare
    /// ("225") and means that unit, exactly as a typed "225" does — the row
    /// never writes the profile unit itself (the web suffixes it at send; one
    /// `takeSavePayload` change would close that for both paths). A spoken
    /// unit is always kept ("225 lb", "62.5 kg"), the profile's or not.
    public static func text(for values: SpokenValues, unit: Weight.Unit?) -> Text {
        Text(
            weight: values.weight.map(weight(_:)),
            reps: values.reps.map(String.init),
            duration: values.durationSeconds.map(duration(_:)),
            rpe: values.rpe.flatMap(rpe(_:))
        )
    }

    /// "225", "62.5 kg", "BW", "BW+25", "BW+10 kg", "BW-10".
    public static func weight(_ spoken: SpokenWeight) -> String {
        let suffix = spoken.unit.map { " " + $0.rawValue } ?? ""
        guard spoken.bodyweight else {
            return number(spoken.value ?? 0) + suffix
        }
        guard let load = spoken.value, spoken.sign != 0 else { return "BW" }
        return "BW" + (spoken.sign < 0 ? "-" : "+") + number(load) + suffix
    }

    /// `DurationBuffer.formatSeconds`: "45s", "1:30", "2:00".
    public static func duration(_ seconds: Int) -> String {
        DurationBuffer.formatSeconds(Double(seconds))
    }

    /// A half step within 1–10 as the RPE field settles it ("8", "7.5"); nil
    /// when out of range.
    public static func rpe(_ value: Double) -> String? {
        let text = SetMetadata.normalizeRpeText(String(value))
        return text.isEmpty ? nil : text
    }

    /// 225 → "225", 62.5 → "62.5": the shortest text that reads back as the number.
    static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }
}
