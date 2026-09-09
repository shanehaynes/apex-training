import ApexCore
import ApexUI
import SwiftUI

/// The confirmation card for one pending coach action: the server-built label,
/// "k of N", Cancel and Confirm. Sits in the bottom inset in place of the
/// composer, so nothing can be typed until it settles.
struct ConfirmationCard: View {
    let label: String
    let index: Int
    let total: Int
    let isBusy: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                Text("Coach wants to").apexEyebrow()
                Spacer()
                if total > 1 {
                    Text(ChatCopy.cardPosition(index: index, total: total))
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .accessibilityIdentifier("coach.card.position")
                }
            }
            Text(label)
                .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("coach.card.label")
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary, action: onCancel)
                    .disabled(isBusy)
                    .accessibilityIdentifier("coach.card.cancel")
                ApexButton("Confirm", kind: .primary, isLoading: isBusy, action: onConfirm)
                    .accessibilityIdentifier("coach.card.confirm")
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.vertical, Spacing.md)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgElevated)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach.card")
    }
}
