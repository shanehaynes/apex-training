import ApexCore
import ApexUI
import SwiftUI

/// The swap picker (`ExercisePicker` restricted to the logged shape, as
/// `TrackerExercise.tsx` opens it): search the cached definitions or create
/// one inline; a pick relabels the rows onto that movement.
struct SwapPickerSheet: View {
    let model: TrackerModel
    let target: SwapTarget
    let onClose: () -> Void

    var body: some View {
        let tracked = target.tracked
        ExercisePickerSheet(
            definitions: model.definitions,
            title: "Swap exercise",
            note: "Logged instead of \(tracked.substitutedFrom ?? tracked.exercise.name) — this day only; the plan is unchanged.",
            restrictTo: TrackerModel.swapCategories(for: tracked),
            excluding: tracked.exercise.definitionId,
            createCategory: tracked.exercise.category,
            confirmLabel: "Create & swap",
            onPick: { definition in
                Task {
                    await model.swap(section: tracked.section, exerciseId: tracked.exercise.id, to: definition)
                    onClose()
                }
            },
            onCreate: { name, category, isUnilateral in
                await model.createDefinition(name: name, category: category, isUnilateral: isUnilateral)
            },
            onClose: onClose
        )
        .accessibilityIdentifier("tracker.swap.picker")
    }
}
