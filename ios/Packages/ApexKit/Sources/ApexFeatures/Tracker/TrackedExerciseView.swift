import ApexCore
import ApexUI
import SwiftUI

/// One exercise (`TrackerExercise.tsx`): name, swap, rest, the swapped note
/// and per-side warning, notes, then either the cardio grid or the set rows.
struct TrackedExerciseView: View {
    let model: TrackerModel
    let tracked: TrackedExercise
    let palette: WorkoutPalette
    var focus: FocusState<FieldID?>.Binding
    let durationModeToggle: Int
    let onSwap: () -> Void

    private var fields: [SetField] { model.inputFields(for: tracked) }
    private var exerciseKey: CardioKey { CardioKey(section: tracked.section, exerciseId: tracked.exercise.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            header
            if let note = swappedNote { noteLine(note, warning: false) }
            if let warning = model.perSideWarning(for: tracked) { noteLine(warning, warning: true) }
            ForEach(notes, id: \.self) { noteLine($0, warning: false) }
            if tracked.isCardio, tracked.cardio != nil {
                CardioRowView(model: model, tracked: tracked, focus: focus)
            } else {
                setTable
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
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
            if model.hasShadows(section: tracked.section, exerciseId: tracked.exercise.id) {
                Button {
                    model.useLast(section: tracked.section, exerciseId: tracked.exercise.id)
                } label: {
                    HStack(spacing: 3) {
                        ApexIcon.ghost.image.font(.system(size: 11))
                        Text("Use last")
                    }
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
                    .foregroundStyle(palette.border)
            }
            if model.canSwap(tracked) {
                Button(action: onSwap) {
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
                Color.clear.frame(width: 32)
            }
            .font(.apex(.mono, size: 10, relativeTo: .caption2))
            .tracking(0.8)
            .textCase(.uppercase)
            .foregroundStyle(ApexColor.textMuted)
            .accessibilityHidden(true)

            ForEach(tracked.sets, id: \.setNumber) { set in
                SetRowView(
                    model: model, tracked: tracked, set: set, fields: fields, focus: focus,
                    durationModeToggle: durationModeToggle
                )
            }

            Button {
                model.addSet(section: tracked.section, exerciseId: tracked.exercise.id)
            } label: {
                HStack(spacing: Spacing.xs) {
                    ApexIcon.plus.image.font(.system(size: 12, weight: .medium))
                    Text("Add set")
                }
                .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                .foregroundStyle(ApexColor.textSecondary)
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 32)
                .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .padding(.top, Spacing.xs)
            .accessibilityIdentifier("tracker.add-set.\(tracked.exercise.id)")
        }
    }
}

/// One set (`SetRow`): number · target · inputs · remove. A shadowed row shows
/// its ghost as an italic placeholder until first focus commits it; an extra
/// row says "extra" where the target would be and can be removed.
struct SetRowView: View {
    let model: TrackerModel
    let tracked: TrackedExercise
    let set: TrackedSet
    let fields: [SetField]
    var focus: FocusState<FieldID?>.Binding
    let durationModeToggle: Int

    private var key: SetKey { SetKey(section: tracked.section, exerciseId: tracked.exercise.id, setNumber: set.setNumber) }
    private var climbing: Bool { tracked.exercise.category == "climbing" }

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

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Text("\(set.setNumber)")
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
                .frame(width: 22, alignment: .leading)
            Text(set.isExtra ? "extra" : CountSpec.plannedLabel(set.planned))
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .italic(set.isExtra)
                .foregroundStyle(ApexColor.textSecondary)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .frame(minWidth: 56, maxWidth: .infinity, alignment: .leading)
            ForEach(fields, id: \.self) { field in
                input(for: field)
                    .frame(width: Self.width(for: field))
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
                .accessibilityIdentifier("tracker.remove.\(tracked.exercise.id).\(set.setNumber)")
            } else {
                Color.clear.frame(width: 32, height: 44)
            }
        }
        .accessibilityIdentifier("tracker.set.\(tracked.exercise.id).\(set.setNumber)")
    }

    @ViewBuilder
    private func input(for field: SetField) -> some View {
        let id = FieldID.set(key, field)
        let ghost = set.shadow?[field] ?? ""
        if field == .duration {
            DurationField(
                value: Binding(get: { model.set(at: key)?[.duration] ?? "" }, set: { model.setValue($0, .duration, at: key) }),
                ghost: ghost.isEmpty ? nil : ghost,
                id: id,
                focus: focus,
                modeToggle: durationModeToggle
            )
            .accessibilityLabel("Set \(set.setNumber) time")
            .accessibilityIdentifier("tracker.input.\(tracked.exercise.id).\(set.setNumber).time")
        } else {
            TrackerTextField(
                text: Binding(get: { model.set(at: key)?[field] ?? "" }, set: { model.setValue($0, field, at: key) }),
                ghost: ghost,
                keyboard: field == .weight && climbing ? .default : .decimalPad,
                id: id,
                focus: focus
            )
            .accessibilityLabel("Set \(set.setNumber) \(Self.label(for: field, climbing: climbing))")
            .accessibilityIdentifier("tracker.input.\(tracked.exercise.id).\(set.setNumber).\(field == .weight ? "weight" : "reps")")
        }
    }
}

/// The mono input every actual uses: surface fill, 44pt, ghost placeholder in
/// the web's `.tracker-input--shadow` treatment (italic, secondary).
struct TrackerTextField: View {
    @Binding var text: String
    let ghost: String
    let keyboard: UIKeyboardType
    let id: FieldID
    var focus: FocusState<FieldID?>.Binding

    var body: some View {
        TextField("", text: $text, prompt: Text(ghost.isEmpty ? " " : ghost).italic().foregroundStyle(ApexColor.textSecondary.opacity(0.9)))
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
                focus.wrappedValue == id ? ApexColor.accent.opacity(0.7) : ApexColor.borderSubtle, lineWidth: 1
            ))
    }
}

/// The 2×2 cardio grid (`.tracker-cardio`): each metric commits its own ghost.
struct CardioRowView: View {
    let model: TrackerModel
    let tracked: TrackedExercise
    var focus: FocusState<FieldID?>.Binding

    private var key: CardioKey { CardioKey(section: tracked.section, exerciseId: tracked.exercise.id) }
    private var cardio: CardioLog { model.editor.exercise(section: tracked.section, id: tracked.exercise.id)?.cardio ?? CardioLog() }

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
                        focus: focus
                    )
                    .accessibilityLabel(label)
                    .accessibilityIdentifier("tracker.cardio.\(tracked.exercise.id).\(field.rawValue)")
                }
            }
        }
    }
}
