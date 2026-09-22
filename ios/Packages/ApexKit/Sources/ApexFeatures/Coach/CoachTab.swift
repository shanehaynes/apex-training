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

    /// Nothing said yet: the tab shows its own full-screen state rather than an
    /// empty thread. The bottom bar reads this too, so the key CTA is never on
    /// screen twice.
    private var isEmptyState: Bool {
        model.messages.isEmpty && !model.isStreaming && model.pending == nil
    }

    public var body: some View {
        Group {
            if isEmptyState {
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
        .apexAnimation(model.pending?.action.toolUseId)
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

    /// One line, no icon: the sparkles said nothing the sentence does not, and
    /// Coach's Notes lives in the toolbar — where it is still reachable once a
    /// thread is open — rather than in two places at once (ux-review §3.6).
    /// The sentence is local because `ChatCopy.emptyWithKey` points at the
    /// button that has gone ("…below").
    private static let emptyLine = "Ask anything — the coach can see your plan and your history."

    private var emptyState: some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            if model.needsKey {
                Text(ChatCopy.emptyWithoutKey)
                    .apexBody()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
                ApexButton(ChatCopy.addKey) { model.showKeySheet = true }
                    .frame(maxWidth: 220)
                    .accessibilityIdentifier("coach.keysetup.add")
            } else {
                Text(Self.emptyLine)
                    .apexBody()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
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
                isDestructive: Self.isDestructive(pending.action.toolName),
                onConfirm: { model.confirm() }, onCancel: { model.cancel() }
            )
        } else if model.needsKey {
            // Nothing to type into until a key exists (ux-review §3.6). On the
            // empty state the full-screen CTA already says so; mid-thread — a
            // 402 on a conversation that has turns — this bar is the only way
            // back to the sheet, and the two never show at once.
            if !isEmptyState { keyBar }
        } else {
            Composer(model: model)
        }
    }

    private var keyBar: some View {
        ApexButton(ChatCopy.addKey) { model.showKeySheet = true }
            .accessibilityIdentifier("coach.keysetup.add")
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.sm)
            .frame(maxWidth: .infinity)
            .background(ApexColor.bgPrimary)
            .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    /// The coach's destructive tools are the `delete_*` family
    /// (`delete_event`, `delete_instance`, `delete_meal`).
    private static func isDestructive(_ toolName: String) -> Bool {
        toolName.lowercased().hasPrefix("delete_")
    }
}
