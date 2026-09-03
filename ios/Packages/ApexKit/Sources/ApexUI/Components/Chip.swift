import SwiftUI

/// A pill filter/tag. Selected state uses the accent, matching `.an-chip` and
/// friends on the web.
public struct Chip: View {
    private let title: String
    private let isSelected: Bool
    private let action: (() -> Void)?

    public init(_ title: String, isSelected: Bool = false, action: (() -> Void)? = nil) {
        self.title = title
        self.isSelected = isSelected
        self.action = action
    }

    public var body: some View {
        let label = Text(title)
            .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
            .foregroundStyle(isSelected ? ApexColor.bgPrimary : ApexColor.textSecondary)
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .background(isSelected ? ApexColor.accent : ApexColor.bgSurface, in: .capsule)
            .overlay(
                Capsule().strokeBorder(isSelected ? .clear : ApexColor.borderSubtle, lineWidth: 1)
            )

        if let action {
            Button(action: action) { label }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
        } else {
            label
        }
    }
}

/// A chip carrying a workout type's own colour language.
public struct TypeChip: View {
    private let palette: WorkoutPalette

    /// Falls back to a neutral chip for a type this build does not know, so a
    /// new server-side type renders rather than crashes.
    public init(rawType: String) {
        self.palette = WorkoutTypeTokens.byRawValue[rawType] ?? WorkoutPalette(
            label: rawType.replacingOccurrences(of: "-", with: " ").capitalized,
            solid: ApexColor.bgElevated,
            border: ApexColor.borderSubtle,
            fill: ApexColor.bgElevated,
            glow: .clear,
            glowRadius: 0
        )
    }

    public var body: some View {
        Text(palette.label)
            .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
            .foregroundStyle(ApexColor.textPrimary)
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.xs)
            .background(palette.fill, in: .capsule)
            .overlay(Capsule().strokeBorder(palette.border, lineWidth: 1))
    }
}
