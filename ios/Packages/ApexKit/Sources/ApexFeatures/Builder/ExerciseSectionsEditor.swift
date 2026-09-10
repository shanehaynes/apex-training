import ApexCore
import ApexUI
import SwiftUI

/// `ExerciseSectionsEditor` from `EventExerciseEditor.tsx`: the three sections
/// as one `List` with real drag handles (U10), a prescription row per entry,
/// the superset link toggle, remove, and Add exercise / Add pitch. Every
/// reorder, link and remove re-letters through `Supersets`; a prescription
/// edit clears the per-set ramp it no longer describes.
struct ExerciseSectionsEditor: View {
    @Binding var lists: WorkoutDraft.Sections
    let workoutType: WorkoutType
    let definitions: [ExerciseDefinition]
    var errors: [String: String] = [:]
    let onCreateDefinition: (String, String, Bool) async -> ExerciseDefinition?

    @State private var adding: SectionKey?

    private var isOutdoor: Bool { workoutType == .outdoorClimbing }

    var body: some View {
        List {
            ForEach(SectionKey.allCases) { key in
                Section {
                    ForEach(binding(for: key)) { $entry in
                        let index = lists[keyPath: key.keyPath].firstIndex { $0.id == entry.id } ?? 0
                        ExerciseEditorRow(
                            entry: $entry,
                            error: errors[entry.id],
                            isPitch: isOutdoor && key == .exercises,
                            linkTitle: linkTitle(for: entry, at: index, in: key),
                            onToggleLink: { toggleLink(entry.id, in: key) },
                            onRemove: { remove(entry.id, from: key) }
                        )
                        .listRowBackground(ApexColor.bgSurface)
                        .listRowSeparatorTint(ApexColor.borderSubtle)
                        .listRowInsets(EdgeInsets(top: Spacing.sm, leading: Spacing.md, bottom: Spacing.sm, trailing: Spacing.md))
                    }
                    .onMove { from, to in
                        var entries = lists[keyPath: key.keyPath]
                        entries.move(fromOffsets: from, toOffset: to)
                        lists[keyPath: key.keyPath] = Supersets.normalize(entries)
                    }
                    .onDelete { offsets in
                        var entries = lists[keyPath: key.keyPath]
                        entries.remove(atOffsets: offsets)
                        lists[keyPath: key.keyPath] = Supersets.normalize(entries)
                    }
                    Button {
                        if isOutdoor, key == .exercises { addPitch() } else { adding = key }
                    } label: {
                        Label(isOutdoor && key == .exercises ? "Add pitch" : "Add exercise", systemImage: ApexIcon.plus.systemName)
                            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(ApexColor.accent)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(ApexColor.bgSurface)
                    .moveDisabled(true)
                    .deleteDisabled(true)
                    .accessibilityIdentifier("editor.add.\(key.rawValue)")
                } header: {
                    Text(key.label(for: workoutType)).apexEyebrow()
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.editMode, .constant(.active))
        .sheet(item: $adding) { key in
            ExercisePickerSheet(
                definitions: definitions,
                restrictTo: isOutdoor && key != .exercises ? ["cardio"] : nil,
                preferredCategory: WorkoutDraft.pickerCategory(for: workoutType),
                onPick: { definition in
                    let taken = allIds
                    lists[keyPath: key.keyPath].append(Entries.entry(from: definition, taken: taken))
                    adding = nil
                },
                onCreate: onCreateDefinition,
                onClose: { adding = nil }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor.sections")
    }

    private var allIds: [String] { (lists.warmup + lists.exercises + lists.cooldown).map(\.id) }

    private func binding(for key: SectionKey) -> Binding<[Exercise]> {
        Binding(get: { lists[keyPath: key.keyPath] }, set: { lists[keyPath: key.keyPath] = $0 })
    }

    private func linkTitle(for entry: Exercise, at index: Int, in key: SectionKey) -> String? {
        let grouped = !(entry.superset ?? "").isEmpty
        if grouped { return "Unlink" }
        return index == 0 ? nil : "Link with above"
    }

    private func toggleLink(_ id: String, in key: SectionKey) {
        let entries = lists[keyPath: key.keyPath]
        guard let entry = entries.first(where: { $0.id == id }) else { return }
        lists[keyPath: key.keyPath] = (entry.superset ?? "").isEmpty
            ? Supersets.linkWithAbove(entries, id: id)
            : Supersets.unlink(entries, id: id)
    }

    private func remove(_ id: String, from key: SectionKey) {
        lists[keyPath: key.keyPath] = Supersets.normalize(lists[keyPath: key.keyPath].filter { $0.id != id })
    }

    private func addPitch() {
        lists.exercises.append(Entries.pitch(after: lists.exercises.last, taken: allIds))
    }
}

/// One entry: name, the prescription (or the pitch's style / grade / ascent),
/// the link toggle and remove. Editing sets/reps/duration/weight/rest clears
/// `plannedSets` — the ramp no longer describes the prescription.
struct ExerciseEditorRow: View {
    @Binding var entry: Exercise
    let error: String?
    let isPitch: Bool
    let linkTitle: String?
    let onToggleLink: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                if let label = entry.superset, !label.isEmpty {
                    Text(label)
                        .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
                        .foregroundStyle(ApexColor.bgPrimary)
                        .frame(width: 18, height: 18)
                        .background(ApexColor.accent, in: .circle)
                        .accessibilityLabel("Superset \(label)")
                }
                Text(entry.name)
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                Spacer(minLength: 0)
                Button(action: onRemove) {
                    ApexIcon.close.image.font(.system(size: 12)).foregroundStyle(ApexColor.textMuted)
                        .frame(width: 32, height: 32).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(entry.name)")
            }
            if isPitch || entry.category == "climbing" {
                pitchFields
            } else {
                prescriptionFields
            }
            HStack(spacing: Spacing.md) {
                if let linkTitle {
                    Button(action: onToggleLink) {
                        Label(linkTitle, systemImage: (linkTitle == "Unlink" ? ApexIcon.unlink : ApexIcon.link).systemName)
                            .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textSecondary)
                            .frame(minHeight: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("editor.link.\(entry.id)")
                }
                if let error {
                    Text(error)
                        .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexPalette.dangerText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor.entry.\(entry.id)")
    }

    private var prescriptionFields: some View {
        VStack(spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                small("Sets", text: setsBinding, keyboard: .numberPad)
                small("Reps", text: field(\.reps))
                small("Weight", text: field(\.weight))
            }
            HStack(spacing: Spacing.xs) {
                small("Duration", text: field(\.duration))
                small("Rest", text: field(\.restPeriod))
            }
        }
    }

    private var pitchFields: some View {
        HStack(spacing: Spacing.xs) {
            menu("Style", options: Entries.climbStyles, selection: Binding(
                get: { entry.climbStyle ?? "sport" },
                set: { style in
                    entry.climbStyle = style
                    if style == "boulder", entry.ascentStyle == "follow" { entry.ascentStyle = nil }
                    if isPitch { entry.name = Entries.climbStyleLabel(style) }
                }
            ))
            small("Grade", text: field(\.grade))
            menu("Ascent", options: [("", "—")] + Entries.ascentStyles(for: entry.climbStyle), selection: Binding(
                get: { entry.ascentStyle ?? "" }, set: { entry.ascentStyle = $0.isEmpty ? nil : $0 }
            ))
        }
    }

    /// A prescription field: a `String?` on the entry, empty = nil; clears the ramp.
    private func field(_ keyPath: WritableKeyPath<Exercise, String?>) -> Binding<String> {
        Binding(
            get: { entry[keyPath: keyPath] ?? "" },
            set: { value in
                entry[keyPath: keyPath] = value.isEmpty ? nil : value
                entry.plannedSets = nil
            }
        )
    }

    private var setsBinding: Binding<String> {
        Binding(
            get: { entry.sets.map(String.init) ?? "" },
            set: { value in
                entry.sets = Int(value)
                entry.plannedSets = nil
            }
        )
    }

    private func small(_ label: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).apexFieldLabel()
            TextField("", text: text, prompt: Text("—").foregroundStyle(ApexColor.textMuted))
                .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .padding(.horizontal, Spacing.sm)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                .accessibilityIdentifier("editor.field.\(entry.id).\(label.lowercased())")
        }
    }

    private func menu(_ label: String, options: [(value: String, label: String)], selection: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).apexFieldLabel()
            Menu {
                ForEach(options, id: \.value) { option in
                    Button(option.label) { selection.wrappedValue = option.value }
                }
            } label: {
                HStack(spacing: Spacing.xs) {
                    Text(options.first { $0.value == selection.wrappedValue }?.label ?? "—")
                        .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textPrimary)
                    Spacer(minLength: 0)
                    ApexIcon.chevronDown.image.font(.system(size: 10)).foregroundStyle(ApexColor.textMuted)
                }
                .padding(.horizontal, Spacing.sm)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
            }
            .accessibilityIdentifier("editor.field.\(entry.id).\(label.lowercased())")
        }
    }
}
