import ApexCore
import ApexUI
import SwiftUI

/// Multiline input with an explicit Send that becomes Stop while the coach is
/// speaking (U22). Return inserts a newline — there is no Enter-to-send idiom
/// on a phone.
struct Composer: View {
    @Bindable var model: CoachModel
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: Spacing.sm) {
            TextField(model.composerPlaceholder, text: $model.composerText, axis: .vertical)
                .lineLimit(1...6)
                .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .tint(ApexColor.accent)
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
                .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(focused ? ApexPalette.borderStrong : ApexColor.borderSubtle, lineWidth: 1))
                .focused($focused)
                .disabled(model.needsKey || model.pending != nil || model.rateLimitedUntil != nil)
                .accessibilityIdentifier("coach.composer")

            if model.isStreaming {
                Button { model.stop() } label: {
                    ApexIcon.stop.image
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(ApexColor.bgPrimary)
                        .frame(width: 44, height: 44)
                        .background(ApexColor.accent, in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop")
                .accessibilityIdentifier("coach.stop")
            } else {
                Button { model.send() } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(model.canSend ? ApexColor.bgPrimary : ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .background(model.canSend ? ApexColor.accent : ApexColor.bgSurface, in: .circle)
                        .overlay(Circle().strokeBorder(model.canSend ? .clear : ApexColor.borderSubtle, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(!model.canSend)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("coach.send")
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.vertical, Spacing.sm)
        .background(ApexColor.bgPrimary)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach.composerbar")
    }
}
