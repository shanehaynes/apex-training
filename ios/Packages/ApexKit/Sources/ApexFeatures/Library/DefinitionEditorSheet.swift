import ApexCore
import ApexUI
import SwiftUI

/// The definition editor (`DefinitionEditor.tsx`) as a sheet: the blast-radius
/// line, the rename hint, the defaults group, Archive/Restore in the footer.
/// A refused save is an `InlineError` above the buttons — a toast would render
/// under the sheet (#167) — and the success toast is the detail screen's,
/// after this closes.
public struct DefinitionEditorSheet: View {
    private let model: LibraryModel
    private let definition: ExerciseDefinition
    private let onClose: () -> Void
    @State private var form: DefinitionForm
    @State private var problem: String?
    @State private var isSaving = false

    public init(model: LibraryModel, definition: ExerciseDefinition, onClose: @escaping () -> Void) {
        self.model = model
        self.definition = definition
        self.onClose = onClose
        _form = State(initialValue: DefinitionForm(definition: definition))
    }

    private var isDirty: Bool { !form.changedFields(against: definition).isEmpty }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Edit exercise", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    radius
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        FormField("Name", text: $form.name, identifier: "library.editor.name")
                        if form.isRenaming(definition) {
                            Text("“\(definition.canonicalName)” stays attached as an alias — PR history follows the rename.")
                                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                                .foregroundStyle(ApexColor.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("library.editor.renamehint")
                        }
                    }
                    ChipRow("Category", options: DefinitionForm.categories.map { ($0, $0.capitalized) }, selection: $form.category, identifier: "library.editor.category")
                    Toggle(isOn: $form.isUnilateral) {
                        Text("Unilateral (counts are per side)")
                            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                            .foregroundStyle(ApexColor.textPrimary)
                    }
                    .tint(ApexColor.accent)
                    .accessibilityIdentifier("library.editor.unilateral")
                    FormField("Muscle groups (comma-separated)", text: $form.muscleGroups, placeholder: "quads, glutes", identifier: "library.editor.muscles")
                    FormField("Equipment (comma-separated)", text: $form.equipment, placeholder: "barbell, rack", identifier: "library.editor.equipment")
                    FormField("Technique notes", text: $form.techniqueNotes, placeholder: "Form cues, setup, safety…", isMultiline: true, identifier: "library.editor.notes")
                    defaults
                }
                .padding(Spacing.screen)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .interactiveDismissDisabled(isDirty)
        .onChange(of: form) { _, _ in problem = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library.editor")
    }

    private var radius: some View {
        let count = model.referenceCount(definition)
        return Text(count.map { "Changes here affect \($0) workout\($0 == 1 ? "" : "s") — everywhere this exercise appears." }
                    ?? "Changes here affect every workout this exercise appears in.")
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("library.editor.radius")
    }

    private var defaults: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Defaults for newly added exercises").apexEyebrow()
            Text("Prefills when this exercise is added to a workout. Existing workouts keep their own sets, reps and weight.")
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Spacing.sm) {
                FormField("Sets", text: $form.defaultSets, keyboard: .numberPad, identifier: "library.editor.sets")
                FormField("Reps", text: $form.defaultReps, identifier: "library.editor.reps")
            }
            HStack(spacing: Spacing.sm) {
                FormField("Duration", text: $form.defaultDuration, placeholder: "45 s", identifier: "library.editor.duration")
                FormField("Weight", text: $form.defaultWeight, placeholder: "135 lb", identifier: "library.editor.weight")
                FormField("Rest", text: $form.defaultRest, placeholder: "2 min", identifier: "library.editor.rest")
            }
        }
    }

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let problem { InlineError(problem, identifier: "library.editor.problem") }
            HStack(spacing: Spacing.sm) {
                ApexButton(definition.archivedAt == nil ? "Archive" : "Restore", kind: .secondary) {
                    Task { await toggleArchive() }
                }
                .disabled(isSaving)
                .accessibilityIdentifier("library.editor.archive")
                Spacer(minLength: 0)
                ApexButton("Cancel", kind: .secondary, action: onClose).disabled(isSaving)
                ApexButton("Save", isLoading: isSaving) { Task { await save() } }
                    .accessibilityIdentifier("library.editor.save")
            }
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    private func save() async {
        guard isDirty else { onClose(); return }
        isSaving = true
        defer { isSaving = false }
        if let refusal = await model.save(definition, form: form) {
            problem = refusal
        } else {
            onClose()
        }
    }

    private func toggleArchive() async {
        isSaving = true
        defer { isSaving = false }
        if let refusal = await model.setArchived(definition, definition.archivedAt == nil) {
            problem = refusal
        } else {
            onClose()
        }
    }
}
