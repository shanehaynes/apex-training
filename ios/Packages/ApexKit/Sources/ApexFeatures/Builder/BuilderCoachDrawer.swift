import ApexCore
import ApexUI
import SwiftUI

/// `BuilderCoachPanel.tsx`: the builder's coach in a drawer under the form.
/// Its one tool edits the draft on the server and the form follows — no
/// confirmation card; only the user's Apply writes anything. A 402 offers the
/// same key sheet the Coach tab uses.
struct BuilderCoachDrawer: View {
    @Bindable var builder: BuilderModel
    @Bindable var coach: CoachModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Coach").apexEyebrow()
                Spacer()
                if coach.isExecuting {
                    HStack(spacing: Spacing.xs) {
                        ProgressView().controlSize(.mini).tint(ApexColor.textMuted)
                        Text("Updating the draft…")
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                    }
                    .accessibilityIdentifier("builder.coach.updating")
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.sm)
            if coach.needsKey {
                VStack(spacing: Spacing.md) {
                    Text(ChatCopy.emptyWithoutKey).apexBody().multilineTextAlignment(.center)
                    ApexButton(ChatCopy.addKey) { coach.showKeySheet = true }
                        .frame(maxWidth: 220)
                        .accessibilityIdentifier("builder.coach.addkey")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(Spacing.screen)
            } else if coach.messages.isEmpty, !coach.isStreaming {
                Text("Describe the workout — the coach fills the form. Only you can press Apply.")
                    .apexBody()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(Spacing.screen)
                    .accessibilityIdentifier("builder.coach.empty")
            } else {
                CoachThreadView(model: coach)
            }
            Composer(model: coach)
        }
        .background(ApexColor.bgPrimary)
        .sheet(isPresented: $coach.showKeySheet) {
            AnthropicKeyView(client: coach.client, hasKey: coach.profile?.hasAnthropicKey ?? false, last4: coach.profile?.anthropicKeyLast4) { status in
                Task { await coach.keyChanged(status) }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("builder.coach")
    }
}
