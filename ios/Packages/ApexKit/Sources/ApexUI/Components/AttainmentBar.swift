import SwiftUI

/// A single-value meter for one weekly target (`BlockProgressBars.tsx`,
/// design-spec §5): label, "actual / target unit" with the percentage, a
/// 6pt track. The bar caps at 100% — over-attainment shows in the number —
/// and its state is keyed off the ROUNDED percentage so the colour never
/// contradicts the label (1,195/1,200 reads "100%" and must not look missed).
public struct AttainmentBar: View {
    public enum State: Sendable {
        case met, close, under

        /// ≥100 met, ≥85 close, else under — on the rounded percentage.
        public init(pct: Double?) {
            let shown = pct.map { Int(($0 * 100).rounded()) } ?? 0
            self = shown >= 100 ? .met : shown >= 85 ? .close : .under
        }

        /// `.block-bar__fill--met/--close/--under`: the climbing border, the
        /// morning-routine solid, the muted text colour.
        var fill: Color {
            switch self {
            case .met: WorkoutTypeTokens.climbing.border
            case .close: WorkoutTypeTokens.morningRoutine.solid
            case .under: ApexColor.textMuted
            }
        }
    }

    private let label: String
    private let valueText: String
    private let pct: Double?
    private let isDerived: Bool
    private let note: String?

    /// `isDerived` tags a target the server inferred from the calendar; `note`
    /// is the unmatched-units line ("Also logged: 12 km — not counted").
    public init(label: String, valueText: String, pct: Double?, isDerived: Bool = false, note: String? = nil) {
        self.label = label
        self.valueText = valueText
        self.pct = pct
        self.isDerived = isDerived
        self.note = note
    }

    public var body: some View {
        let state = State(pct: pct)
        let width = min(1, max(0, pct ?? 0))
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                HStack(spacing: Spacing.xs) {
                    Text(label)
                        .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textPrimary)
                    if isDerived {
                        Text("calendar")
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                            .padding(.horizontal, Spacing.xs).padding(.vertical, 1)
                            .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                            .accessibilityLabel("derived from the calendar")
                    }
                }
                Spacer(minLength: Spacing.sm)
                HStack(spacing: Spacing.xs) {
                    Text(valueText)
                        .foregroundStyle(ApexColor.textSecondary)
                    Text(Self.pctText(pct))
                        .foregroundStyle(state.fill)
                        .fontWeight(.medium)
                }
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .monospacedDigit()
                .lineLimit(1)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(ApexColor.bgElevated)
                    Capsule().fill(state.fill).frame(width: geometry.size.width * width)
                }
            }
            .frame(height: 6)
            if let note {
                Text(note)
                    .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(Self.pctText(pct))
    }

    /// "92%", or "—" when there was no target to divide by.
    public static func pctText(_ pct: Double?) -> String {
        guard let pct else { return "—" }
        return "\(Int((pct * 100).rounded()))%"
    }

    /// "210 / 300 min" — a tenth at most, thousands separated, like the web's `format`.
    public static func valueText(actual: Double, target: Double, unit: String) -> String {
        let text = "\(number(actual)) / \(number(target))"
        return unit.isEmpty ? text : "\(text) \(unit)"
    }

    /// "Also logged: 12 km — not counted, different unit."
    public static func unmatchedNote(_ units: [String: Double]?) -> String? {
        guard let units, !units.isEmpty else { return nil }
        let parts = units.keys.sorted().map { "\(number(units[$0]!)) \($0)" }
        return "Also logged: \(parts.joined(separator: ", ")) — not counted, different unit."
    }

    static func number(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 1
        return formatter.string(from: NSNumber(value: rounded)) ?? String(rounded)
    }
}
