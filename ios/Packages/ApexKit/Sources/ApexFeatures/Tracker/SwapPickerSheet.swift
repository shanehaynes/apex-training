import ApexCore
import ApexUI
import SwiftUI

/// The swap picker (`ExercisePicker` restricted to the logged shape): search
/// over the cached definitions; a pick relabels the rows onto that movement.
struct SwapPickerSheet: View {
    let model: TrackerModel
    let target: SwapTarget
    let onClose: () -> Void

    @State private var query = ""
    @FocusState private var searching: Bool

    private var candidates: [ExerciseDefinition] {
        TrackerModel.swapCandidates(model.definitions, for: target.tracked, query: query)
            .filter { $0.id != target.tracked.exercise.definitionId }
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Swap exercise", onClose: onClose)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Logged instead of \(target.tracked.substitutedFrom ?? target.tracked.exercise.name) — this day only; the plan is unchanged.")
                    .apexBody()
                TextField("", text: $query, prompt: Text("Search movements").foregroundStyle(ApexColor.textMuted))
                    .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .autocorrectionDisabled()
                    .focused($searching)
                    .padding(.horizontal, Spacing.md)
                    .frame(height: 44)
                    .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
                    .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                    .accessibilityIdentifier("tracker.swap.search")
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.md)
            if candidates.isEmpty {
                EmptyState(eyebrow: "No matches", message: "Nothing in the library logs the same way. Add it from the Library first.", symbol: ApexIcon.dumbbell.systemName)
            } else {
                List(candidates, id: \.id) { definition in
                    Button {
                        Task {
                            await model.swap(section: target.tracked.section, exerciseId: target.tracked.exercise.id, to: definition)
                            onClose()
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(definition.canonicalName)
                                .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                                .foregroundStyle(ApexColor.textPrimary)
                            Text(subtitle(definition))
                                .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(ApexColor.bgSurface)
                    .listRowSeparatorTint(ApexColor.borderSubtle)
                    .accessibilityIdentifier("tracker.swap.option.\(definition.id)")
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(ApexColor.bgSurface)
        .onAppear { searching = true }
        .accessibilityIdentifier("tracker.swap.picker")
    }

    private func subtitle(_ definition: ExerciseDefinition) -> String {
        var parts: [String] = []
        if let category = definition.category { parts.append(category.capitalized) }
        if definition.isUnilateral == true { parts.append("unilateral") }
        if let groups = definition.muscleGroups, !groups.isEmpty { parts.append(groups.prefix(3).joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}
