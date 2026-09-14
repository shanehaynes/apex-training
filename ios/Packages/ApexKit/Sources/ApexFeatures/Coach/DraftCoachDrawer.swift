import ApexCore
import ApexUI
import SwiftUI

/// What differs between the drawers: the copy and the accessibility prefix.
public struct DraftCoachCopy: Sendable {
    public let emptyHint: String
    public let updating: String
    public let idPrefix: String

    public init(emptyHint: String, updating: String, idPrefix: String) {
        self.emptyHint = emptyHint
        self.updating = updating
        self.idPrefix = idPrefix
    }

    /// `BuilderCoachPanel.tsx`.
    public static let builder = DraftCoachCopy(
        emptyHint: "Describe the workout — the coach fills the form. Only you can press Apply.",
        updating: "Updating the draft…", idPrefix: "builder.coach"
    )
    /// `AnalyticsCoachPanel.tsx`.
    public static let analytics = DraftCoachCopy(
        emptyHint: "Describe the chart — the coach configures the tile. Only you can press Save.",
        updating: "Updating the tile…", idPrefix: "analytics.coach"
    )
}

/// The draft coach in a drawer under a form (`BuilderCoachPanel.tsx`,
/// `AnalyticsCoachPanel.tsx`): its one tool edits the draft on the server
/// and the form follows — no confirmation card; only the user's Apply or Save
/// writes anything. A 402 offers the same key sheet the Coach tab uses.
struct DraftCoachDrawer: View {
    @Bindable var coach: CoachModel
    let copy: DraftCoachCopy

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Coach").apexEyebrow()
                Spacer()
                if coach.isExecuting {
                    HStack(spacing: Spacing.xs) {
                        ProgressView().controlSize(.mini).tint(ApexColor.textMuted)
                        Text(copy.updating)
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                    }
                    .accessibilityIdentifier("\(copy.idPrefix).updating")
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.sm)
            if coach.needsKey {
                VStack(spacing: Spacing.md) {
                    Text(ChatCopy.emptyWithoutKey).apexBody().multilineTextAlignment(.center)
                    ApexButton(ChatCopy.addKey) { coach.showKeySheet = true }
                        .frame(maxWidth: 220)
                        .accessibilityIdentifier("\(copy.idPrefix).addkey")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(Spacing.screen)
            } else if coach.messages.isEmpty, !coach.isStreaming {
                Text(copy.emptyHint)
                    .apexBody()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(Spacing.screen)
                    .accessibilityIdentifier("\(copy.idPrefix).empty")
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
        .accessibilityIdentifier(copy.idPrefix)
    }
}
