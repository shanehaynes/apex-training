import ApexCore
import ApexUI
import SwiftUI

/// "Edit exercises" on the event sheet (`EventExerciseEditor`'s modal mode):
/// the sections editor over a copy, Save sends only the sections that
/// changed, always series-wide — there is no occurrence scope here.
struct EditExercisesSheet: View {
    let model: ScheduleModel
    let event: ScheduleEvent
    let onClose: () -> Void

    @State private var lists: WorkoutDraft.Sections
    @State private var original: WorkoutDraft.Sections
    @State private var definitions: [ExerciseDefinition] = []
    @State private var errors: [String: String] = [:]
    @State private var isSaving = false

    init(model: ScheduleModel, event: ScheduleEvent, onClose: @escaping () -> Void) {
        self.model = model
        self.event = event
        self.onClose = onClose
        let sections = WorkoutDraft.Sections(warmup: event.base.warmup ?? [], exercises: event.base.exercises ?? [], cooldown: event.base.cooldown ?? [])
        _lists = State(initialValue: sections)
        _original = State(initialValue: sections)
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Edit exercises", onClose: onClose)
            if event.isRecurring {
                Text("Changes apply to every occurrence of the series.")
                    .apexBody()
                    .padding(.horizontal, Spacing.screen)
                    .padding(.bottom, Spacing.sm)
            }
            ExerciseSectionsEditor(
                lists: $lists, workoutType: event.type, definitions: definitions, errors: errors,
                onCreateDefinition: { name, category, unilateral in
                    let created = await model.createDefinition(name: name, category: category, isUnilateral: unilateral)
                    if let created { definitions.append(created) }
                    return created
                }
            )
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary, action: onClose)
                ApexButton("Save", isLoading: isSaving) { Task { await save() } }
                    .accessibilityIdentifier("editor.save")
            }
            .padding(Spacing.screen)
            .background(ApexColor.bgSurface)
        }
        .task { definitions = await model.definitions() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule.event.exercises")
    }

    private func save() async {
        errors = Entries.unilateralViolations(lists, definitions: definitions)
        guard errors.isEmpty else { return }
        let warmup = lists.warmup == original.warmup ? nil : lists.warmup
        let exercises = lists.exercises == original.exercises ? nil : lists.exercises
        let cooldown = lists.cooldown == original.cooldown ? nil : lists.cooldown
        guard warmup != nil || exercises != nil || cooldown != nil else { onClose(); return }
        isSaving = true
        let ok = await model.commit(.setSections(event, warmup: warmup, exercises: exercises, cooldown: cooldown))
        isSaving = false
        if ok { onClose() }
    }
}
