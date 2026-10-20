import ApexCore
import ApexUI
import Combine
import SwiftUI
import UIKit

/// The tracker (`TrackerView.tsx`): header, section groups, the finish gate in
/// a bottom inset the keyboard lifts, the summary as an overlay inside the
/// cover, and the sync chip the web never needed.
public struct TrackerScreen: View {
    @Bindable private var model: TrackerModel
    private let onClose: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    /// "Pick…" on the voice strip: the picker opens on the spoken phrase.
    @State private var pickingForVoice = false

    @FocusState private var focus: FieldID?
    @State private var swapTarget: SwapTarget?
    @State private var addingExercise = false
    @State private var durationModeToggle = 0
    /// You → Training's "Rate sets by effort": an RPE field on every set row.
    @AppStorage(TrackerModel.rpePreferenceKey) private var showsRpe = false
    /// A select-all asked for before the field took over as first responder.
    @State private var selectAllPending = false
    /// The field that began editing since the last focus change, if any.
    @State private var editingField: UITextField?

    public init(model: TrackerModel, onClose: @escaping () -> Void) {
        self.model = model
        self.onClose = onClose
    }

    private var palette: WorkoutPalette { WorkoutTypeTokens.palette(for: model.event.type.rawValue) }

    public var body: some View {
        VStack(spacing: 0) {
            TrackerHeader(model: model, palette: palette, onClose: onClose) {
                focus = nil
                model.tapMic()
            }
            if let label = model.syncLabel {
                SyncStatusStrip(label: label)
            }
            if model.voice != .idle {
                VoiceStrip(
                    state: model.voice,
                    onUndo: { model.undoSpoken() },
                    onConfirm: { model.confirmSpoken($0) },
                    onPick: { pickingForVoice = true },
                    onRetry: {
                        focus = nil
                        model.retryVoice()
                    },
                    onSettings: { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } },
                    onDismiss: { model.dismissVoice() }
                )
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
        .apexAnimation(model.gate)
        .apexAnimation(model.summary == nil)
        .apexAnimation(model.rest.isRunning)
        .apexAnimation(model.voice)
        .toolbar { keyboardAccessory }
        .sheet(item: $swapTarget) { target in
            SwapPickerSheet(model: model, target: target) { swapTarget = nil }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(ApexColor.bgSurface)
        }
        .sheet(isPresented: $addingExercise) {
            ExercisePickerSheet(
                definitions: model.definitions,
                title: "Add exercise",
                note: "Added to this workout only — the plan is unchanged.",
                restrictTo: TrackerModel.addableCategories,
                createCategory: "strength",
                confirmLabel: "Create & add",
                onPick: { definition in
                    addingExercise = false
                    model.addExercise(definition)
                },
                onCreate: { name, category, isUnilateral in
                    await model.createDefinition(name: name, category: category, isUnilateral: isUnilateral)
                },
                onClose: { addingExercise = false }
            )
            .accessibilityIdentifier("tracker.add.picker")
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .sheet(isPresented: $pickingForVoice) {
            ExercisePickerSheet(
                definitions: model.definitions,
                title: "Which exercise?",
                note: "Added to this workout only — the spoken set goes on it.",
                restrictTo: TrackerModel.voiceAddableCategories,
                createCategory: "strength",
                confirmLabel: "Create & log",
                initialQuery: model.voicePhrase,
                onPick: { definition in
                    pickingForVoice = false
                    model.pickSpoken(definition)
                },
                onCreate: { name, category, isUnilateral in
                    await model.createDefinition(name: name, category: category, isUnilateral: isUnilateral)
                },
                onClose: { pickingForVoice = false }
            )
            .accessibilityIdentifier("tracker.voice.picker")
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .onChange(of: focus) { old, new in focusChanged(from: old, to: new) }
        // Away from the screen the microphone goes off and nothing is applied (W17).
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.cancelVoice() } }
        .onChange(of: model.voice) { _, state in announce(state) }
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { note in
            didBeginEditing(note.object as? UITextField)
        }
        // The summary and the cancel confirm are modal moments: no input keeps the keyboard.
        .onChange(of: model.summary == nil) { _, hidden in if !hidden { focus = nil } }
        .onChange(of: model.gate) { _, gate in if gate == .confirmCancel || gate == .needsScore { focus = nil } }
        .sensoryFeedback(.impact(weight: .light), trigger: model.loggedSetCount)
        .sensoryFeedback(.success, trigger: model.prCount)
        .sensoryFeedback(.success, trigger: model.completedCount)
        .sensoryFeedback(.impact(weight: .medium), trigger: model.confirmCount)
        // The buzz at zero (D-015): UINotificationFeedbackGenerator's success,
        // fired by the tick, so only while the tracker is up — the island
        // carries the countdown when it is not.
        .sensoryFeedback(.success, trigger: model.restEndedCount)
        // Voice (W17): a listen started, an ask, a failure; the logged set
        // itself rides on `loggedSetCount` above.
        .sensoryFeedback(.impact(weight: .light), trigger: model.voiceListenCount)
        .sensoryFeedback(.warning, trigger: model.voiceConfirmCount)
        .sensoryFeedback(.error, trigger: model.voiceFailCount)
        .preferredColorScheme(.dark)
    }

    /// VoiceOver hears what the strip shows the moment it changes; the live
    /// transcript is hidden from it (the strip updates frequently instead).
    private func announce(_ state: VoiceLogState) {
        let text: String
        switch state {
        case .applied(_, let label): text = label
        case .confirming: text = "Did you mean — choose the exercise"
        case .unresolved(let phrase, _): text = "No exercise named \(phrase)"
        case .failed(_, let reason), .denied(let reason): text = reason
        default: return
        }
        AccessibilityNotification.Announcement(text).post()
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
                // Eager, both levels: every card and every field exists before
                // the first frame, so a fling realizes nothing and the scroll
                // view knows its full height. The lazy stacks this replaces
                // built each card — ten to fifteen UIKit text fields — in the
                // frame it entered the viewport, a visible hitch per card at
                // 120 Hz, and estimated the rest. Eager is affordable because
                // the rows are `Equatable` values (`ExerciseRowInput`): a
                // keystroke re-evaluates one card, one row and one field, which
                // is the problem laziness was guarding against.
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
                                    model: model, input: rowInput(tracked), focus: $focus,
                                    onSwap: { swapTarget = SwapTarget(tracked: $0) }
                                )
                                .equatable()
                            }
                        }
                    }
                    if !model.isFinished { addExerciseButton }
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

    /// One card's inputs, computed here so the card itself reads nothing off
    /// the model and can be skipped when they are unchanged.
    private func rowInput(_ tracked: TrackedExercise) -> ExerciseRowInput {
        let exerciseKey = CardioKey(section: tracked.section, exerciseId: tracked.exercise.id)
        let focused: FieldID? = switch focus {
        case .set(let key, _) where key.exerciseKey == exerciseKey: focus
        case .rpe(let key) where key.exerciseKey == exerciseKey: focus
        case .cardio(let key, _) where key == exerciseKey: focus
        default: nil
        }
        return ExerciseRowInput(
            tracked: tracked, fields: model.inputFields(for: tracked), perSideWarning: model.perSideWarning(for: tracked),
            canSwap: model.canSwap(tracked), inLibrary: model.libraryDefinition(for: tracked) != nil,
            focusedField: focused, durationModeToggle: durationModeToggle, showsRpe: showsRpe
        )
    }

    private var addExerciseButton: some View {
        Button {
            focus = nil
            addingExercise = true
        } label: {
            HStack(spacing: Spacing.xs) {
                ApexIcon.plus.image.font(.system(size: 13, weight: .medium))
                Text("Add exercise")
            }
            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
            .foregroundStyle(ApexColor.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
        .buttonStyle(.plain)
        .disabled(model.gate == .finishing || model.gate == .cancelling)
        .accessibilityIdentifier("tracker.add-exercise")
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
            } else if model.rest.isRunning {
                RestTimerBar(model: model)
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
        if case .rpe(let key) = old { model.didLeaveRpe(key) }
        let wantsSelectAll: Bool = switch new {
        case .set(let key, _): model.focusSet(at: key)
        case .rpe: false
        case .cardio(let key, let field): model.focusCardio(field, at: key)
        case nil: false
        }
        selectAll(wantsSelectAll)
    }

    /// `@FocusState` and UIKit's first responder do not change in a fixed
    /// order, and the 50 ms `asyncAfter` this replaces was a guess at one: when
    /// it fired early there was no first responder to take `selectAll`, or the
    /// field being left took it, and the next keystroke appended to the ghost
    /// value that had just been committed instead of replacing it.
    ///
    /// Both orders are covered instead, off the field's own begin-editing:
    ///
    /// - A tap makes the field first responder *before* SwiftUI publishes the
    ///   focus change, so `editingField` already holds it — select now.
    /// - A programmatic move (the keyboard accessory's Next, or Use last) runs
    ///   this *before* UIKit hands over, so the request waits for the
    ///   notification and is spent on the field that actually takes over.
    private func selectAll(_ wanted: Bool) {
        if wanted, let field = editingField {
            selectAllPending = false
            field.selectAll(nil)
        } else {
            selectAllPending = wanted
        }
        // Whatever began editing belonged to the focus that just ended.
        editingField = nil
    }

    private func didBeginEditing(_ field: UITextField?) {
        guard let field else { return }
        if selectAllPending {
            selectAllPending = false
            field.selectAll(nil)
        } else {
            editingField = field
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
    /// The microphone (W17); the screen drops the keyboard before the tap.
    let onVoice: () -> Void

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
                    // Date · timer on one line while they fit; at the accessibility
                    // sizes the timer would wrap mid-digit, so they stack instead (W13).
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Spacing.sm) {
                            dateText
                            Text("·").foregroundStyle(ApexColor.textMuted)
                            elapsedText
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            dateText
                            elapsedText
                        }
                    }
                }
                .padding(.top, 10)

                Spacer(minLength: Spacing.sm)

                if model.showsVoice {
                    VoiceMicButton(state: model.voice, isDisabled: model.voiceDisabled, action: onVoice)
                        .padding(.top, 4)
                }

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
                        // 44pt is the HIG minimum, and this one sits next to
                        // the back button (already 44) in a sweaty-handed
                        // screen — the capsule grows, the type does not.
                        .frame(minHeight: 44)
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
                        // The HIG minimum, as above: the one button that ends
                        // a workout should not be the smallest target on screen.
                        .frame(minHeight: 44)
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

    private var dateText: some View {
        Text(model.dateLabel)
            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
            .foregroundStyle(ApexColor.textMuted)
            .lineLimit(1)
    }

    private var elapsedText: some View {
        Text(model.elapsedLabel)
            .font(.apex(.mono, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(model.isFinished ? ApexColor.textMuted : ApexColor.textPrimary)
            .accessibilityIdentifier("tracker.elapsed")
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
        .accessibilityElement(children: .contain)
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
