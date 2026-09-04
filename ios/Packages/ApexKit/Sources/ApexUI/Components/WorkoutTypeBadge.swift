import SwiftUI

/// The `.day-event-card__badge` pill: solid fill in the type's colour, its label
/// in primary text. Distinct from `TypeChip`, which is the translucent filter chip.
public struct WorkoutTypeBadge: View {
    private let palette: WorkoutPalette

    public init(rawType: String) {
        self.palette = WorkoutTypeTokens.palette(for: rawType)
    }

    public var body: some View {
        Text(palette.label)
            .font(.apex(.display, size: TypeScale.micro, weight: .semibold, relativeTo: .caption2))
            .tracking(0.3)
            .foregroundStyle(ApexColor.textPrimary)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, 3)
            .background(palette.solid, in: .capsule)
    }
}
