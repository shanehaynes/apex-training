import SwiftUI

/// The one-line "cached · updated 3h ago" / "schedule cached through Jan 2"
/// affordance (U17). Muted on purpose: information, not an alarm.
public struct FreshnessBanner: View {
    private let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        HStack(spacing: Spacing.sm) {
            ApexIcon.offline.image
                .font(.system(size: 12))
            Text(text)
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
        }
        .foregroundStyle(ApexColor.textMuted)
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .bottom) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityIdentifier("schedule.freshness")
    }
}
