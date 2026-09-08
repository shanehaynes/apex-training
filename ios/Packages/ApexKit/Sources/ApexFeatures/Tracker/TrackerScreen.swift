import ApexCore
import ApexUI
import SwiftUI

/// The tracker (`TrackerView.tsx`): header, section groups, the finish gate in
/// a bottom inset the keyboard lifts, the summary as an overlay inside the
/// cover, and the sync chip the web never needed.
public struct TrackerScreen: View {
    @Bindable private var model: TrackerModel
    private let onClose: () -> Void

    @FocusState private var focus: FieldID?
    @State private var swapTarget: SwapTarget?
    @State private var durationModeToggle = 0

    public init(model: TrackerModel, onClose: @escaping () -> Void) {
        self.model = model
        self.onClose = onClose
    }

    private var palette: WorkoutPalette { WorkoutTypeTokens.palette(for: model.event.type.rawValue) }

    public var body: some View {
        VStack(spacing: 0) {
            TrackerHeader(model: model, palette: palette, onClose: onClose)
            if let label = model.syncLabel {
                SyncStatusStrip(label: label)
            }
            content
        }
        .background(ApexColor.bgPrimary)
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .overlay {
            if let summary = model.summary {
                SummaryOverlay(model: model, summary: summary, onBack: onClose)
                    .transition(.opacity)
            }
        }
        .animation(Motion.spring, value: model.gate)
        .animation(Motion.spring, value: model.summary == nil)
        .toolbar { keyboardAccessory }
        .sheet(item: $swapTarget) { target in
            SwapPickerSheet(model: model, target: target) { swapTarget = nil }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(ApexColor.bgSurface)
        }
        .onChange(of: focus) { old, new in focusChanged(from: old, to: new) }
        // The summary and the cancel confirm are modal moments: no input keeps the keyboard.
        .onChange(of: model.summary == nil) { _, hidden in if !hidden { focus = nil } }
        .onChange(of: model.gate) { _, gate in if gate == .confirmCancel || gate == .needsScore { focus = nil } }
        .sensoryFeedback(.impact(weight: .light), trigger: model.loggedSetCount)
        .sensoryFeedback(.success, trigger: model.prCount)
        .sensoryFeedback(.success, trigger: model.completedCount)
        .sensoryFeedback(.impact(weight: .medium), trigger: model.confirmCount)
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("tracker")
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ZStack {
                ApexColor.bgPrimary.ignoresSafeArea()
                VStack(spacing: Spacing.md) {
                    ProgressView().tint(ApexColor.textMuted)
                    Text("Loading session…").apexBody()
                }
            }
        case .unavailable(let message):
            VStack(spacing: Spacing.md) {
                EmptyState(eyebrow: "Offline", message: message, symbol: ApexIcon.offline.systemName)
                    .frame(maxHeight: 240)
                ApexButton("Retry", kind: .secondary) { Task { await model.open() } }
                    .frame(maxWidth: 200)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    if model.isFinished {
                        Text("This workout is finished — reps and weights are still editable, and edits save as you type.")
                            .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                            .accessibilityIdentifier("tracker.finished-note")
                    }
                    ForEach(model.editor.groups, id: \.section) { group in
                        VStack(alignment: .leading, spacing: Spacing.lg) {
                            SectionRule(label: group.label)
                            ForEach(group.exercises, id: \.exercise.id) { tracked in
                                TrackedExerciseView(
                                    model: model, tracked: tracked, palette: palette, focus: $focus,
                                    durationModeToggle: durationModeToggle,
                                    onSwap: { swapTarget = SwapTarget(tracked: tracked) }
                                )
                            }
                        }
                    }
                    cancelButton
                }
                .padding(.horizontal, Spacing.screen)
                .padding(.top, Spacing.lg)
                .padding(.bottom, Spacing.xxl)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var cancelButton: some View {
        Button {
            model.confirmCancel()
        } label: {
            HStack(spacing: Spacing.xs) {
                ApexIcon.trash.image.font(.system(size: 13))
                Text("Cancel workout")
            }
            .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
            .foregroundStyle(ApexColor.textMuted)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .disabled(model.gate == .finishing || model.gate == .cancelling)
        .accessibilityIdentifier("tracker.cancel")
    }

    // MARK: - Bottom inset

    @ViewBuilder
    private var bottomBar: some View {
        switch model.gate {
        case .needsConfirm(let count):
            ConfirmBar(
                message: "\(count) planned \(count == 1 ? "set" : "sets") unlogged — recorded as 0.",
                primary: .init("Finish anyway") { Task { await model.requestFinish(force: true) } },
                secondary: .init("Keep going") { model.keepGoing() }
            )
        case .needsScore:
            ScoreCard(model: model)
        case .confirmCancel, .cancelling:
            ConfirmBar(
                message: "Cancel this workout? Everything logged for this session is deleted — it can't be resumed.",
                primary: .init(model.gate == .cancelling ? "Discarding…" : "Discard workout") {
                    Task { if await model.cancelWorkout() { onClose() } }
                },
                secondary: .init("Keep going") { model.keepGoing() },
                isDestructive: true,
                isBusy: model.gate == .cancelling
            )
            .accessibilityIdentifier("tracker.cancel-confirm")
        case .idle, .finishing:
            if let failure = model.failureLabel {
                ConfirmBar(
                    message: "\(failure) \(model.sync.lastError ?? "")",
                    primary: .init("Retry") { Task { await model.retryFailed() } },
                    secondary: .init("Discard") { Task { await model.discardFailed() } }
                )
                .accessibilityIdentifier("tracker.sync-failed")
            }
        }
    }

    // MARK: - Keyboard

    @ToolbarContentBuilder
    private var keyboardAccessory: some ToolbarContent {
        ToolbarItemGroup(placement: .keyboard) {
            if let focus, case .set(let key, _) = focus, model.hasShadows(section: key.section, exerciseId: key.exerciseId) {
                Button("Use last") { model.useLast(section: key.section, exerciseId: key.exerciseId) }
                    .accessibilityIdentifier("tracker.keyboard.use-last")
            }
            if let focus, case .set(_, .duration) = focus {
                Button("Abc / 123") { durationModeToggle += 1 }
                    .accessibilityIdentifier("tracker.keyboard.mode")
            }
            Spacer()
            if let focus, model.nextField(after: focus) != nil {
                Button("Next") { self.focus = model.nextField(after: focus) }
                    .accessibilityIdentifier("tracker.keyboard.next")
            }
            Button("Done") { focus = nil }
                .fontWeight(.semibold)
                .accessibilityIdentifier("tracker.keyboard.done")
        }
    }

    /// Focus arriving on a ghost row commits it, then selects the text so the
    /// first keystroke replaces rather than appends (the web's `focusShadow`).
    private func focusChanged(from old: FieldID?, to new: FieldID?) {
        if case .set(let key, _) = old { model.didLeaveSet(key) }
        switch new {
        case .set(let key, _):
            if model.focusSet(at: key) { selectAllSoon() }
        case .cardio(let key, let field):
            if model.focusCardio(field, at: key) { selectAllSoon() }
        case nil:
            break
        }
    }

    private func selectAllSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
        }
    }
}

struct SwapTarget: Identifiable {
    let tracked: TrackedExercise
    var id: String { "\(tracked.section)|\(tracked.exercise.id)" }
}

/// Back · title on its own line · date · elapsed · Finish (U27). The 2pt rule
/// carries the type's colour, like the web header's border.
struct TrackerHeader: View {
    let model: TrackerModel
    let palette: WorkoutPalette
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: Spacing.sm) {
                Button(action: onClose) {
                    ApexIcon.chevronLeft.image
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(ApexColor.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to calendar")
                .accessibilityIdentifier("tracker.back")

                VStack(alignment: .leading, spacing: 2) {
                    Text(model.event.title)
                        .font(.apex(.display, size: TypeScale.base, weight: .bold, relativeTo: .headline))
                        .foregroundStyle(ApexColor.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("tracker.title")
                    HStack(spacing: Spacing.sm) {
                        Text(model.dateLabel)
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                        Text("·").foregroundStyle(ApexColor.textMuted)
                        Text(model.elapsedLabel)
                            .font(.apex(.mono, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .monospacedDigit()
                            .foregroundStyle(model.isFinished ? ApexColor.textMuted : ApexColor.textPrimary)
                            .accessibilityIdentifier("tracker.elapsed")
                    }
                }
                .padding(.top, 10)

                Spacer(minLength: Spacing.sm)

                if model.isFinished {
                    Button {
                        Task { await model.openSavedSummary() }
                    } label: {
                        HStack(spacing: Spacing.xs) {
                            ApexIcon.checkCircle.image.font(.system(size: 14, weight: .semibold))
                            Text("Done")
                        }
                        .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.positive)
                        .padding(.horizontal, Spacing.md)
                        .frame(minHeight: 36)
                        .overlay(Capsule().strokeBorder(ApexPalette.positive.opacity(0.6), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                    .accessibilityIdentifier("tracker.done")
                } else {
                    Button {
                        Task { await model.requestFinish() }
                    } label: {
                        HStack(spacing: Spacing.xs) {
                            ApexIcon.flag.image.font(.system(size: 13, weight: .semibold))
                            Text("Finish")
                        }
                        .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                        .foregroundStyle(ApexColor.bgPrimary)
                        .padding(.horizontal, Spacing.lg)
                        .frame(minHeight: 36)
                        .background(ApexColor.accent, in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.phase != .ready || model.gate == .finishing)
                    .opacity(model.phase == .ready ? 1 : 0.5)
                    .padding(.top, 4)
                    .accessibilityIdentifier("tracker.finish")
                }
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.trailing, Spacing.sm)
            .padding(.bottom, Spacing.sm)
            Rectangle().fill(palette.solid).frame(height: 2)
        }
        .background(ApexColor.bgPrimary)
    }
}

/// "N sets pending sync" — quiet, like the freshness banner.
struct SyncStatusStrip: View {
    let label: String

    var body: some View {
        HStack(spacing: Spacing.sm) {
            ApexIcon.pendingSync.image.font(.system(size: 12))
            Text(label).font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
        }
        .foregroundStyle(ApexColor.textMuted)
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.xs)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .bottom) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityIdentifier("tracker.sync")
    }
}

/// The web's `.modal-section`: a label between two rules.
struct SectionRule: View {
    let label: String

    var body: some View {
        HStack(spacing: Spacing.md) {
            Rectangle().fill(ApexColor.borderSubtle).frame(height: 1)
            Text(label).apexEyebrow().fixedSize()
            Rectangle().fill(ApexColor.borderSubtle).frame(height: 1)
        }
    }
}
