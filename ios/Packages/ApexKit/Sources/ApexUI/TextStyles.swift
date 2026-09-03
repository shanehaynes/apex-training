import SwiftUI

/// The recurring type patterns from design-spec §2, as modifiers rather than
/// loose font calls, so a heading looks the same on every screen.
extension View {
    /// 10→11pt, 700, tracked, uppercase, muted. The little label above a section.
    public func apexEyebrow() -> some View {
        font(.apex(.display, size: TypeScale.micro, weight: .bold, relativeTo: .caption))
            .tracking(1.4)
            .textCase(.uppercase)
            .foregroundStyle(ApexColor.textMuted)
    }

    /// Mono, 12pt, uppercase — the label above a form field.
    public func apexFieldLabel() -> some View {
        font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
            .tracking(0.7)
            .textCase(.uppercase)
            .foregroundStyle(ApexColor.textMuted)
    }

    /// 24pt, 700 — sheet and section titles.
    public func apexTitle() -> some View {
        font(.apex(.display, size: TypeScale.xxl, weight: .bold, relativeTo: .title2))
            .tracking(-0.5)
            .foregroundStyle(ApexColor.textPrimary)
    }

    public func apexBody() -> some View {
        font(.apex(.display, size: TypeScale.base, relativeTo: .body))
            .foregroundStyle(ApexColor.textSecondary)
    }

    /// Numbers, timers, KPI values — always mono, always tabular.
    public func apexNumeric(size: CGFloat = TypeScale.xxl, weight: Font.Weight = .bold) -> some View {
        font(.apex(.mono, size: size, weight: weight, relativeTo: .title2))
            .monospacedDigit()
            .foregroundStyle(ApexColor.textPrimary)
    }
}

/// The `APEX` wordmark: Barlow Condensed 700, widely tracked (design-spec §2).
public struct Wordmark: View {
    public init() {}

    public var body: some View {
        Text("APEX")
            .font(.apex(.wordmark, size: 22, weight: .bold, relativeTo: .headline))
            .tracking(4.8)
            .foregroundStyle(ApexColor.textPrimary)
            .accessibilityLabel("Apex")
    }
}
