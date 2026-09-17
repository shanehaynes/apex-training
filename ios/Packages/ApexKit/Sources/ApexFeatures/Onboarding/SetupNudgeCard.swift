import ApexCore
import ApexUI
import SwiftUI

/// The slim "Finish setting up" card at the top of the Schedule tab (W13,
/// U32) — the web's `SetupNudge`: the three rows the profile answers without
/// another request, a score, a session-only close. Each row's button goes
/// straight to the thing it names.
public struct SetupNudgeCard: View {
    private let model: OnboardingModel

    public init(model: OnboardingModel) {
        self.model = model
    }

    public var body: some View {
        let rows = model.nudgeRows
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Text("Finish setting up")
                    .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .subheadline))
                    .foregroundStyle(ApexColor.textPrimary)
                Text("\(model.nudgeDoneCount)/\(rows.count)")
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .accessibilityIdentifier("onboarding.nudge.score")
                Spacer(minLength: 0)
                Button { model.nudgeHidden = true } label: {
                    ApexIcon.close.image
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("onboarding.nudge.dismiss")
            }
            .frame(minHeight: 32)
            ForEach(rows) { row in
                HStack(spacing: Spacing.sm) {
                    ZStack {
                        Circle()
                            .strokeBorder(row.done ? ApexPalette.positive : ApexColor.borderSubtle, lineWidth: 1)
                            .background(Circle().fill(row.done ? ApexPalette.positive : .clear))
                        if row.done {
                            ApexIcon.check.image
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(ApexColor.bgPrimary)
                        }
                    }
                    .frame(width: 18, height: 18)
                    .accessibilityHidden(true)
                    Text(row.item.label)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .subheadline))
                        .foregroundStyle(row.done ? ApexColor.textMuted : ApexColor.textPrimary)
                        .strikethrough(row.done, color: ApexColor.textMuted)
                        .lineLimit(2)
                    Spacer(minLength: Spacing.sm)
                    if !row.done {
                        Button {
                            Task { await model.run(row.item.action, for: row.id.rawValue) }
                        } label: {
                            Text(row.item.action.label)
                                .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                                .foregroundStyle(ApexColor.textPrimary)
                                .padding(.horizontal, Spacing.md)
                                .frame(minHeight: 32)
                                .background(ApexColor.bgElevated, in: .capsule)
                                .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .frame(minHeight: 44)
                        .disabled(row.id == .template && model.isCopying)
                        .accessibilityIdentifier("onboarding.nudge.action.\(row.id.rawValue)")
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(row.item.label), \(row.done ? "done" : "not done")")
                .accessibilityIdentifier("onboarding.nudge.row.\(row.id.rawValue)")
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.nudge")
    }
}
