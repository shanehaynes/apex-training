import SwiftUI

/// A pill filter/tag. Selected state uses the accent, matching `.an-chip` and
/// friends on the web.
public struct Chip: View {
    private let title: String
    private let isSelected: Bool
    private let isDimmed: Bool
    private let tint: Color?
    private let action: (() -> Void)?

    /// `isDimmed` is the web's `.an-chip--dimmed`: an option a prior choice
    /// rules out. It stays tappable so the reason can show (U13) — the caller
    /// decides what a tap does. `tint` colours the chip's border (and its
    /// selected fill) — a workout type's own colour on its chip.
    public init(_ title: String, isSelected: Bool = false, isDimmed: Bool = false, tint: Color? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.isSelected = isSelected
        self.isDimmed = isDimmed
        self.tint = tint
        self.action = action
    }

    public var body: some View {
        let label = Text(title)
            .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
            .foregroundStyle(isSelected ? (tint == nil ? ApexColor.bgPrimary : ApexColor.textPrimary) : ApexColor.textSecondary)
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .background(isSelected ? (tint.map { $0.opacity(0.35) } ?? ApexColor.accent) : ApexColor.bgSurface, in: .capsule)
            .overlay(
                Capsule().strokeBorder(isSelected && tint == nil ? .clear : (tint ?? ApexColor.borderSubtle), lineWidth: 1)
            )
            .opacity(isDimmed ? 0.4 : 1)

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
        self.palette = WorkoutTypeTokens.palette(for: rawType)
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
