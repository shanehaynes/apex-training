import ApexCore
import ApexUI
import SwiftUI

/// The Coach tab (D-012): the thread, the composer or the confirmation card in
/// a bottom inset the keyboard lifts (U3), conversations and Notes in the
/// toolbar, the model badge (U31), and the key sheet one tap from the 402 state.
public struct CoachTab: View {
    private let model: CoachModel?

    public init(model: CoachModel?) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            if let model {
                CoachScreen(model: model)
            } else {
                EmptyState(eyebrow: "Coach", message: "Signing in…", symbol: ApexIcon.sparkles.systemName)
                    .navigationTitle("Coach")
            }
        }
    }
}

public struct CoachScreen: View {
    @Bindable private var model: CoachModel

    public init(model: CoachModel) {
        self.model = model
    }

    public var body: some View {
        Group {
            if model.messages.isEmpty, !model.isStreaming, model.pending == nil {
                emptyState
            } else {
                CoachThreadView(model: model)
            }
        }
        .background(ApexColor.bgPrimary)
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarLeading) {
                Button { model.showConversations = true } label: { ApexIcon.history.image }
                    .accessibilityLabel("Conversations")
                    .accessibilityIdentifier("coach.conversations")
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: Spacing.xs) {
                    Button { model.notes() } label: { ApexIcon.notes.image }
                        .disabled(!model.canStartTurn)
                        .accessibilityLabel(ChatCopy.notesTitle)
                        .accessibilityIdentifier("coach.notes")
                    Button { model.newConversation() } label: { ApexIcon.newChat.image }
                        .disabled(model.isStreaming || model.pending != nil)
                        .accessibilityLabel("New conversation")
                        .accessibilityIdentifier("coach.new")
                }
            }
        }
        .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .tint(ApexColor.textPrimary)
        .sheet(isPresented: $model.showConversations) {
            ConversationListView(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(ApexColor.bgSurface)
        }
        .sheet(isPresented: $model.showKeySheet) {
            AnthropicKeyView(
                client: model.client, hasKey: model.profile?.hasAnthropicKey ?? false,
                last4: model.profile?.anthropicKeyLast4
            ) { status in
                Task { await model.keyChanged(status) }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: model.confirmCount)
        .animation(Motion.spring, value: model.pending?.action.toolUseId)
        .task { await model.start() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach.screen")
    }

    private var header: some View {
        VStack(spacing: 2) {
            Text("Coach").apexEyebrow()
            if let label = model.modelLabel {
                Text(label)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textSecondary)
                    .accessibilityIdentifier("coach.model")
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            Image(systemName: ApexIcon.sparkles.systemName)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(ApexColor.textMuted)
            if model.needsKey {
                Text(ChatCopy.emptyWithoutKey)
                    .apexBody()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
                ApexButton(ChatCopy.addKey) { model.showKeySheet = true }
                    .frame(maxWidth: 220)
                    .accessibilityIdentifier("coach.keysetup.add")
            } else {
                Text(ChatCopy.emptyWithKey)
                    .apexBody()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
                ApexButton(ChatCopy.notesTitle, kind: .secondary) { model.notes() }
                    .frame(maxWidth: 220)
                    .accessibilityIdentifier("coach.empty.notes")
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Spacing.screen)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(model.needsKey ? "coach.keysetup" : "coach.empty")
    }

    @ViewBuilder
    private var bottomBar: some View {
        if let pending = model.pending {
            ConfirmationCard(
                label: pending.action.displayLabel, index: pending.index, total: pending.total,
                isBusy: model.isExecuting || model.isActionLatched,
                onConfirm: { model.confirm() }, onCancel: { model.cancel() }
            )
        } else {
            Composer(model: model)
        }
    }
}
