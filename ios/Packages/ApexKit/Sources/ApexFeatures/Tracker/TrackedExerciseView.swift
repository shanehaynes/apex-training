import ApexCore
import ApexUI
import SwiftUI

/// Everything one exercise card draws, as a single value SwiftUI can compare.
///
/// The scroll content is eager (every card and field exists before the first
/// frame, so a fling realizes nothing), which only works if a keystroke does
/// not re-evaluate every card: `TrackedExerciseView` and `SetRowView` are
/// `Equatable` on these values alone — never on the model reference, the
/// focus binding or a closure — so one keystroke re-evaluates one card, one
/// row and one field, and a focus move the two rows whose border changes.
/// `TrackerScreen` computes them; nothing here reads `model.editor`. The one
/// value every input carries is `durationModeToggle`: an "Abc / 123" tap
/// re-evaluates every row (as it always did), and it must stay that way —
/// zeroing it for unfocused rows would hand `DurationField` the jump in the
/// same pass that focuses it, and flip its mode.
nonisolated struct ExerciseRowInput: Equatable, Sendable {
    let tracked: TrackedExercise
    let fields: [SetField]
    let perSideWarning: String?
    let canSwap: Bool
    /// Whether the model holds the entry's library definition — what a "+ weight"
    /// tap writes to. Without one the field is this workout's only.
    let inLibrary: Bool
    /// The focused field, when it lies inside this exercise; nil otherwise, so
    /// a focus move elsewhere compares equal here.
    let focusedField: FieldID?
    let durationModeToggle: Int
    /// You → Training's RPE preference: a rating field on every set row.
    let showsRpe: Bool
}

/// One exercise (`TrackerExercise.tsx`): name, swap or remove, rest, the swapped or added note
/// and per-side warning, notes, then either the cardio grid or the set rows.
struct TrackedExerciseView: View, Equatable {
    let model: TrackerModel
    let input: ExerciseRowInput
    var focus: FocusState<FieldID?>.Binding
    let onSwap: (TrackedExercise) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.input == rhs.input
    }

    private var tracked: TrackedExercise { input.tracked }
    private var fields: [SetField] { input.fields }
    /// Off the event, a `let` on the model: constant for the screen's life,
    /// so it is not part of the compared input (its `Equatable` is
    /// main-actor-isolated, which a `nonisolated` value cannot use anyway).
    private var palette: WorkoutPalette { WorkoutTypeTokens.palette(for: model.event.type.rawValue) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            header
            if let note = swappedNote { noteLine(note, warning: false) }
            if let warning = input.perSideWarning { noteLine(warning, warning: true) }
            ForEach(notes, id: \.self) { noteLine($0, warning: false) }
            if tracked.isCardio, tracked.cardio != nil {
                CardioRowView(model: model, tracked: tracked, focusedField: focusedCardioField, focus: focus)
                    .equatable()
            } else {
                setTable
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        // Contain, or this identifier would replace every child's (SwiftUI applies
        // an outer identifier to the whole subtree otherwise).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracker.exercise.\(tracked.exercise.id)")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Text(tracked.exercise.name)
                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let superset = tracked.exercise.superset, !superset.isEmpty {
                Text(superset)
                    .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
                    .foregroundStyle(ApexColor.bgPrimary)
                    .frame(width: 18, height: 18)
                    .background(palette.border, in: .circle)
                    .accessibilityLabel("Superset \(superset) — alternate sets with its partners")
            }
            Spacer(minLength: 0)
            if tracked.hasShadows {
                Button {
                    model.useLast(section: tracked.section, exerciseId: tracked.exercise.id)
                } label: {
                    // Text only — the wand said "magic" about a control that
                    // just copies last session's numbers (ux-review §3.4).
                    Text("Use last")
                        .lineLimit(1)
                        .fixedSize()
                        .font(.apex(.display, size: TypeScale.micro, weight: .semibold, relativeTo: .caption2))
                        .foregroundStyle(ApexColor.textSecondary)
                        .padding(.horizontal, Spacing.sm)
                        .frame(minHeight: 28)
                        .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .accessibilityIdentifier("tracker.use-last.\(tracked.exercise.id)")
            }
            if let rest = tracked.exercise.restPeriod, !rest.isEmpty {
                Text("Rest \(rest)")
                    .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                    // Rest is a fact about the set, not a status (ux-review §3.4).
                    .foregroundStyle(ApexColor.textSecondary)
            }
            if tracked.added {
                Button {
                    model.removeAddedExercise(section: tracked.section, exerciseId: tracked.exercise.id)
                } label: {
                    ApexIcon.close.image
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(tracked.exercise.name) from this workout")
                .accessibilityIdentifier("tracker.remove.\(tracked.exercise.id)")
            }
            if input.canSwap {
                Button { onSwap(tracked) } label: {
                    ApexIcon.swap.image
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Swap exercise")
                .accessibilityIdentifier("tracker.swap.\(tracked.exercise.id)")
            }
        }
    }

    private var swappedNote: String? {
        if tracked.added { return "Added to this workout — the plan is unchanged." }
        guard let from = tracked.substitutedFrom else { return nil }
        return "Logged instead of \(from) — this day only, the plan is unchanged."
    }

    /// Side conventions once, then technique notes, then the entry's own notes.
    private var notes: [String] {
        var out: [String] = []
        if let spec = CountSpec.countSpecNote(reps: tracked.exercise.reps, duration: tracked.exercise.duration) { out.append(spec) }
        if let technique = tracked.exercise.techniqueNotes, !technique.isEmpty { out.append(technique) }
        if let note = tracked.exercise.notes, !note.isEmpty, note != tracked.exercise.techniqueNotes { out.append(note) }
        return out
    }

    private func noteLine(_ text: String, warning: Bool) -> some View {
        Text(text)
            .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
            .italic(!warning)
            .foregroundStyle(warning ? WorkoutTypeTokens.morningRoutine.solid : ApexColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(warning ? "tracker.warning.\(tracked.exercise.id)" : "tracker.note")
    }

    private var setTable: some View {
        VStack(spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Text("#").frame(width: 22, alignment: .leading)
                Text(tracked.exercise.category == "climbing" ? "route" : "target").frame(minWidth: 56, maxWidth: .infinity, alignment: .leading)
                ForEach(fields, id: \.self) { field in
                    Text(SetRowView.label(for: field, climbing: tracked.exercise.category == "climbing"))
                        .frame(width: SetRowView.width(for: field), alignment: .leading)
                }
                if input.showsRpe {
                    Text("rpe").frame(width: SetRowView.rpeWidth, alignment: .leading)
                }
                Color.clear.frame(width: 32)
            }
            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
            .tracking(0.8)
            .textCase(.uppercase)
            .foregroundStyle(ApexColor.textMuted)
            .accessibilityHidden(true)

            ForEach(tracked.sets, id: \.setNumber) { set in
                SetRowView(
                    model: model,
                    input: SetRowInput(
                        key: SetKey(section: tracked.section, exerciseId: tracked.exercise.id, setNumber: set.setNumber),
                        set: set, fields: fields, added: tracked.added, climbing: tracked.exercise.category == "climbing",
                        climbStyle: tracked.exercise.climbStyle,
                        focusedField: focusedSetField(of: set), durationModeToggle: input.durationModeToggle,
                        showsRpe: input.showsRpe, rpeFocused: input.focusedField == .rpe(SetKey(
                            section: tracked.section, exerciseId: tracked.exercise.id, setNumber: set.setNumber
                        ))
                    ),
                    focus: focus
                )
                .equatable()
            }

            HStack(spacing: Spacing.xs) {
                Button {
                    model.addSet(section: tracked.section, exerciseId: tracked.exercise.id)
                } label: {
                    dashedChip("Add set")
                }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .accessibilityIdentifier("tracker.add-set.\(tracked.exercise.id)")
                // "+ weight / + reps / + time" (TrackerExercise.tsx `addable`): the
                // input the card lacks, added now and — through the definition's
                // `log_fields` — to every workout that references the movement.
                ForEach(addable, id: \.self) { field in
                    Button {
                        Task { await model.addField(field, section: tracked.section, exerciseId: tracked.exercise.id) }
                    } label: {
                        dashedChip(SetRowView.label(for: field, climbing: false))
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Track \(SetRowView.label(for: field, climbing: false)) for \(tracked.exercise.name)")
                    .accessibilityHint(input.inLibrary
                        ? "From now on, in every workout"
                        : "For this workout — the exercise is not in the library")
                    .accessibilityIdentifier("tracker.add-field.\(tracked.exercise.id).\(field.logField)")
                }
            }
            .padding(.top, Spacing.xs)
        }
    }

    private var addable: [SetField] { TrackerEditor.addableFields(for: tracked, fields: fields) }

    private func dashedChip(_ text: String) -> some View {
        HStack(spacing: Spacing.xs) {
            ApexIcon.plus.image.font(.system(size: 12, weight: .medium))
            Text(text).lineLimit(1)
        }
        .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
        .foregroundStyle(ApexColor.textSecondary)
        .padding(.horizontal, Spacing.md)
        .frame(minHeight: 32)
        .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
    }

    /// The field of `set` that has focus, if focus is on this set at all.
    private func focusedSetField(of set: TrackedSet) -> SetField? {
        guard case .set(let key, let field) = input.focusedField, key.setNumber == set.setNumber else { return nil }
        return field
    }

    private var focusedCardioField: CardioField? {
        guard case .cardio(_, let field) = input.focusedField else { return nil }
        return field
    }
}

/// One set row's inputs, as a value (see `ExerciseRowInput`).
nonisolated struct SetRowInput: Equatable, Sendable {
    let key: SetKey
    let set: TrackedSet
    let fields: [SetField]
    let added: Bool
    let climbing: Bool
    /// The pitch's discipline: a boulder problem offers no "Followed".
    let climbStyle: String?
    /// The field of this set that has focus, if any.
    let focusedField: SetField?
    let durationModeToggle: Int
    let showsRpe: Bool
    let rpeFocused: Bool
}

/// One set (`SetRow`): number · target · inputs · remove. A shadowed row shows
/// its ghost as an italic placeholder until first focus commits it; an extra
/// row says "extra" where the target would be and can be removed.
///
/// Every value it shows comes from the `SetRowInput` it was handed, never from
/// `model.editor`: reading the editor here registered each of a workout's set
/// rows as an observer of the *whole* editor, so one keystroke in one field
/// invalidated every field in every exercise. `TrackerScreen` holds the one
/// subscription; the fresh value flows down from there — and the row is
/// `Equatable` on that value, so rows whose set did not change are skipped.
struct SetRowView: View, Equatable {
    let model: TrackerModel
    let input: SetRowInput
    var focus: FocusState<FieldID?>.Binding

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.input == rhs.input
    }

    private var key: SetKey { input.key }
    private var set: TrackedSet { input.set }
    private var fields: [SetField] { input.fields }
    private var climbing: Bool { input.climbing }

    static func label(for field: SetField, climbing: Bool) -> String {
        switch field {
        case .weight: climbing ? "grade" : "weight"
        case .reps: "reps"
        case .duration: "time"
        }
    }

    static func width(for field: SetField) -> CGFloat {
        field == .reps ? 60 : 78
    }

    static let rpeWidth: CGFloat = 48

    private var isWarmup: Bool { self.set.isWarmup ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            mainRow
            if climbing { pitchRow }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracker.set.\(key.exerciseId).\(set.setNumber)")
    }

    /// The leading slot is the warm-up toggle (`.tracker-set__warmup`): the
    /// set number at rest, a W once marked. A warm-up set is logged and shown
    /// like any other and counted in no stat.
    private var warmupToggle: some View {
        Button {
            model.setWarmup(!isWarmup, at: key)
        } label: {
            Text(isWarmup ? "W" : "\(set.setNumber)")
                .font(.apex(.mono, size: TypeScale.xs, weight: isWarmup ? .semibold : .regular, relativeTo: .caption))
                .foregroundStyle(isWarmup ? WorkoutTypeTokens.morningRoutine.solid : ApexColor.textMuted)
                .frame(width: 22, height: 44, alignment: .leading)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isWarmup
            ? "Set \(set.setNumber) is a warm-up — tap to count it"
            : "Set \(set.setNumber) — tap to mark as a warm-up")
        .accessibilityAddTraits(isWarmup ? .isSelected : [])
        .accessibilityIdentifier("tracker.warmup.\(key.exerciseId).\(set.setNumber)")
    }

    private var mainRow: some View {
        HStack(spacing: Spacing.sm) {
            warmupToggle
            Text(CountSpec.targetLabel(of: set, added: input.added))
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .italic(set.isExtra && !input.added)
                .foregroundStyle(ApexColor.textSecondary)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .accessibilityIdentifier("tracker.planned.\(key.exerciseId).\(set.setNumber)")
                .frame(minWidth: 56, maxWidth: .infinity, alignment: .leading)
            ForEach(fields, id: \.self) { field in
                input(for: field)
                    .frame(width: Self.width(for: field))
            }
            if input.showsRpe {
                TrackerTextField(
                    text: Binding(get: { set.rpe ?? "" }, set: { model.setRpe($0, at: key) }),
                    ghost: "",
                    keyboard: .decimalPad,
                    id: .rpe(key),
                    isFocused: input.rpeFocused,
                    focus: focus
                )
                .frame(width: Self.rpeWidth)
                .accessibilityLabel("Set \(set.setNumber) RPE")
                .accessibilityIdentifier("tracker.input.\(key.exerciseId).\(set.setNumber).rpe")
            }
            if set.isExtra {
                Button {
                    model.removeSet(at: key)
                } label: {
                    ApexIcon.close.image
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ApexColor.textMuted)
                        .frame(width: 32, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove set \(set.setNumber)")
                .accessibilityIdentifier("tracker.remove.\(key.exerciseId).\(set.setNumber)")
            } else {
                Color.clear.frame(width: 32, height: 44)
            }
        }
    }

    /// A pitch's ascent (`PitchControls`): how it went, and the goes it took.
    /// On a line of its own — beside the grade there is no room on a phone.
    private var pitchRow: some View {
        let attempts = SetMetadata.parseAttempts(set.attempts)
        return HStack(spacing: Spacing.sm) {
            Menu {
                Button("No style") { model.setAscentStyle(nil, at: key) }
                ForEach(SetMetadata.ascentStyles(for: input.climbStyle)) { style in
                    Button(style.label) { model.setAscentStyle(style.value, at: key) }
                }
            } label: {
                HStack(spacing: Spacing.xs) {
                    Text(SetMetadata.ascentLabel(set.ascentStyle) ?? "Style")
                        .foregroundStyle(set.ascentStyle == nil ? ApexColor.textMuted : ApexColor.textPrimary)
                    ApexIcon.chevronDown.image.font(.system(size: 10, weight: .medium)).foregroundStyle(ApexColor.textMuted)
                }
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .padding(.horizontal, Spacing.sm)
                .frame(minWidth: 110, minHeight: 36, alignment: .leading)
                .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
                .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
            }
            .accessibilityLabel("Set \(set.setNumber) ascent style")
            .accessibilityValue(SetMetadata.ascentLabel(set.ascentStyle) ?? "None")
            .accessibilityIdentifier("tracker.style.\(key.exerciseId).\(set.setNumber)")

            HStack(spacing: 0) {
                stepButton("minus", label: "Fewer attempts", enabled: attempts != nil) { model.stepAttempts(by: -1, at: key) }
                Text(attempts.map(String.init) ?? "–")
                    .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .frame(minWidth: 24)
                    .accessibilityIdentifier("tracker.attempts.\(key.exerciseId).\(set.setNumber)")
                stepButton("plus", label: "More attempts", enabled: true) { model.stepAttempts(by: 1, at: key) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Set \(set.setNumber) attempts")
            .accessibilityValue(attempts.map { "\($0)" } ?? "Not counted")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: model.stepAttempts(by: 1, at: key)
                case .decrement: model.stepAttempts(by: -1, at: key)
                @unknown default: break
                }
            }
            Text("tries")
                .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                .textCase(.uppercase)
                .foregroundStyle(ApexColor.textMuted)
                .accessibilityHidden(true)
        }
        .padding(.leading, 22 + Spacing.sm)
    }

    private func stepButton(_ symbol: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(enabled ? ApexColor.textSecondary : ApexColor.textMuted.opacity(0.5))
                .frame(width: 36, height: 36)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func input(for field: SetField) -> some View {
        let id = FieldID.set(key, field)
        let prompt = TrackerEditor.prompt(of: set, field: field)
        let ghost = prompt.text
        if field == .duration {
            DurationField(
                value: Binding(get: { set[.duration] }, set: { model.setValue($0, .duration, at: key) }),
                ghost: ghost.isEmpty ? nil : ghost,
                id: id,
                isFocused: input.focusedField == .duration,
                focus: focus,
                modeToggle: input.durationModeToggle
            )
            .accessibilityLabel("Set \(set.setNumber) time")
            .accessibilityIdentifier("tracker.input.\(key.exerciseId).\(set.setNumber).time")
        } else {
            TrackerTextField(
                text: Binding(get: { set[field] }, set: { model.setValue($0, field, at: key) }),
                ghost: ghost,
                hint: !prompt.commits,
                keyboard: field == .weight && climbing ? .default : .decimalPad,
                id: id,
                isFocused: input.focusedField == field,
                focus: focus
            )
            .accessibilityLabel("Set \(set.setNumber) \(Self.label(for: field, climbing: climbing))")
            .accessibilityIdentifier("tracker.input.\(key.exerciseId).\(set.setNumber).\(field == .weight ? "weight" : "reps")")
        }
    }
}

/// The mono input every actual uses: surface fill, 44pt, ghost placeholder in
/// the web's `.tracker-input--shadow` treatment (italic, secondary).
///
/// `isFocused` is handed in rather than read off `focus.wrappedValue`: that
/// read made every field in the workout re-evaluate on each focus move. The
/// binding is still what `.focused` needs to move focus.
struct TrackerTextField: View {
    @Binding var text: String
    let ghost: String
    /// A plain placeholder rather than a ghost (`.tracker-input::placeholder`,
    /// muted at 0.6): a tap commits nothing, so it must not look like
    /// something that will be logged.
    var hint = false
    let keyboard: UIKeyboardType
    let id: FieldID
    let isFocused: Bool
    var focus: FocusState<FieldID?>.Binding

    var body: some View {
        TextField("", text: $text, prompt: Text(ghost.isEmpty ? " " : ghost).italic(!hint).foregroundStyle(hint ? ApexColor.textMuted.opacity(0.6) : ApexColor.textSecondary.opacity(0.9)))
            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textPrimary)
            .keyboardType(keyboard)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .submitLabel(.next)
            .focused(focus, equals: id)
            .padding(.horizontal, Spacing.sm)
            .frame(height: 44)
            .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(
                isFocused ? ApexColor.accent.opacity(0.7) : ApexColor.borderSubtle, lineWidth: 1
            ))
    }
}

/// The 2×2 cardio grid (`.tracker-cardio`): each metric commits its own ghost.
struct CardioRowView: View, Equatable {
    let model: TrackerModel
    let tracked: TrackedExercise
    /// The metric that has focus, if focus is on this exercise.
    let focusedField: CardioField?
    var focus: FocusState<FieldID?>.Binding

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.tracked == rhs.tracked && lhs.focusedField == rhs.focusedField
    }

    private var key: CardioKey { CardioKey(section: tracked.section, exerciseId: tracked.exercise.id) }
    private var cardio: CardioLog { tracked.cardio ?? CardioLog() }

    private static let fields: [(CardioField, String, String, UIKeyboardType)] = [
        (.durationMinutes, "Duration (min)", "45", .decimalPad),
        (.distance, "Distance", "5 mi", .default),
        (.elevationGain, "Elevation gain", "800 ft", .default),
        (.avgHeartRate, "Avg heart rate", "145", .numberPad),
    ]

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Spacing.sm) {
            ForEach(Self.fields, id: \.0) { field, label, placeholder, keyboard in
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(label).apexFieldLabel()
                    TrackerTextField(
                        text: Binding(get: { cardio[field] }, set: { model.setCardio($0, field, at: key) }),
                        ghost: cardio.shadow?[field].isEmpty == false ? cardio.shadow![field] : placeholder,
                        keyboard: keyboard,
                        id: .cardio(key, field),
                        isFocused: focusedField == field,
                        focus: focus
                    )
                    .accessibilityLabel(label)
                    .accessibilityIdentifier("tracker.cardio.\(tracked.exercise.id).\(field.rawValue)")
                }
            }
        }
    }
}
