import SwiftUI

/// A labelled row of toggling `Chip`s — the web's `MultiChips` (filters that
/// take several values). A dimmed chip is one a prior choice rules out; it
/// stays tappable and a tap shows `dimReason` under the row instead of
/// toggling (U13: the reason is visible without a hover).
public struct MultiChipRow: View {
    private let label: String
    private let options: [(value: String, label: String)]
    private let values: [String]
    private let dimmed: (String) -> Bool
    private let dimReason: String?
    private let tint: (String) -> Color?
    private let identifier: String?
    private let onToggle: (String) -> Void

    @State private var showReason = false

    public init(
        _ label: String, options: [(value: String, label: String)], values: [String],
        dimmed: @escaping (String) -> Bool = { _ in false }, dimReason: String? = nil,
        tint: @escaping (String) -> Color? = { _ in nil }, identifier: String? = nil,
        onToggle: @escaping (String) -> Void
    ) {
        self.label = label
        self.options = options
        self.values = values
        self.dimmed = dimmed
        self.dimReason = dimReason
        self.tint = tint
        self.identifier = identifier
        self.onToggle = onToggle
    }

    private var id: String { identifier ?? "chips.\(label.lowercased().replacingOccurrences(of: " ", with: "-"))" }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            FlowLayout(spacing: Spacing.xs) {
                ForEach(options, id: \.value) { option in
                    let isOff = dimmed(option.value) && !values.contains(option.value)
                    Chip(option.label, isSelected: values.contains(option.value), isDimmed: isOff, tint: tint(option.value)) {
                        if isOff {
                            withAnimation(Motion.spring) { showReason = true }
                        } else {
                            withAnimation(Motion.spring) { onToggle(option.value) }
                        }
                    }
                    .accessibilityAddTraits(values.contains(option.value) ? .isSelected : [])
                    .accessibilityIdentifier("\(id).\(option.value)")
                }
            }
            if showReason, let dimReason {
                Text(dimReason)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .accessibilityIdentifier("\(id).reason")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}
