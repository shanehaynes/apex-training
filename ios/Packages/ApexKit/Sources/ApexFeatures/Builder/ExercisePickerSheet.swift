import ApexCore
import ApexUI
import SwiftUI

/// `ExercisePicker.tsx`: search-first over the cached library (canonical name,
/// aliases, muscle groups), category chips, and exact-match-or-create — a name
/// that matches nothing offers an inline create (category + unilateral) that
/// writes the definition immediately, as the web does.
struct ExercisePickerSheet: View {
    let definitions: [ExerciseDefinition]
    /// Hard-limits the categories offered (the approach / descent of an
    /// outdoor day take cardio only).
    var restrictTo: [String]? = nil
    /// The chip pre-selected for the workout type (`TYPE_CATEGORY`).
    var preferredCategory: String? = nil
    /// Previews and snapshots open the sheet mid-flow.
    var initialQuery = ""
    var initialCreating = false
    let onPick: (ExerciseDefinition) -> Void
    let onCreate: (String, String, Bool) async -> ExerciseDefinition?
    let onClose: () -> Void

    @State private var query = ""
    @State private var category: String?
    @State private var creating = false
    @State private var newCategory = "strength"
    @State private var newUnilateral = false
    @State private var busy = false
    @FocusState private var searching: Bool

    private var categories: [(value: String, label: String)] {
        Entries.categories.filter { restrictTo?.contains($0.value) ?? true }
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    private var results: [ExerciseDefinition] {
        let needle = trimmed.lowercased()
        let allowed = Set(categories.map(\.value))
        return definitions
            .filter { $0.archivedAt == nil && allowed.contains($0.category ?? "") }
            .filter { category == nil || $0.category == category }
            .filter { definition in
                guard !needle.isEmpty else { return true }
                if definition.canonicalName.lowercased().contains(needle) { return true }
                if (definition.aliases ?? []).contains(where: { $0.lowercased().contains(needle) }) { return true }
                return (definition.muscleGroups ?? []).contains { $0.lowercased().contains(needle) }
            }
            .sorted { $0.canonicalName.localizedCaseInsensitiveCompare($1.canonicalName) == .orderedAscending }
    }

    /// Exact-match-or-create: two characters and nothing exact in the library.
    private var canCreate: Bool { trimmed.count > 1 && Entries.match(trimmed, in: definitions) == nil }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Add exercise", onClose: onClose)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    ApexIcon.search.image.font(.system(size: 14)).foregroundStyle(ApexColor.textMuted)
                    TextField("", text: $query, prompt: Text("Search the library").foregroundStyle(ApexColor.textMuted))
                        .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .autocorrectionDisabled()
                        .focused($searching)
                        .accessibilityIdentifier("picker.search")
                }
                .apexFieldChrome()
                if categories.count > 1 {
                    FlowLayout(spacing: Spacing.xs) {
                        Chip("All", isSelected: category == nil) { category = nil }
                        ForEach(categories, id: \.value) { option in
                            Chip(option.label, isSelected: category == option.value) { category = category == option.value ? nil : option.value }
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.md)

            List {
                if canCreate {
                    createRow
                }
                if results.isEmpty, !canCreate {
                    Text(definitions.isEmpty ? "The library is empty — type a name to add the first exercise." : "No matches — keep typing to create it.")
                        .apexBody()
                        .listRowBackground(ApexColor.bgSurface)
                }
                ForEach(results, id: \.id) { definition in
                    Button { onPick(definition) } label: {
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
                    .accessibilityIdentifier("picker.option.\(definition.id)")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
        .background(ApexColor.bgSurface)
        .onAppear {
            searching = true
            if let preferredCategory, categories.contains(where: { $0.value == preferredCategory }) { category = preferredCategory }
            newCategory = preferredCategory ?? categories.first?.value ?? "strength"
            if query.isEmpty { query = initialQuery }
            if initialCreating { creating = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("picker")
    }

    @ViewBuilder
    private var createRow: some View {
        if creating {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("New exercise: \(trimmed)")
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                ChipRow("Category", options: categories, selection: $newCategory, identifier: "picker.create.category")
                Toggle("Unilateral (counts per side)", isOn: $newUnilateral)
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .tint(ApexColor.accent)
                    .accessibilityIdentifier("picker.create.unilateral")
                HStack(spacing: Spacing.sm) {
                    ApexButton("Back", kind: .secondary) { creating = false }
                    ApexButton("Create & add", isLoading: busy) {
                        busy = true
                        Task {
                            if let created = await onCreate(trimmed, newCategory, newUnilateral || Entries.hasPerSideCount(trimmed)) {
                                onPick(created)
                            }
                            busy = false
                        }
                    }
                    .accessibilityIdentifier("picker.create.confirm")
                }
            }
            .padding(.vertical, Spacing.sm)
            .listRowBackground(ApexColor.bgSurface)
        } else {
            Button { creating = true } label: {
                Label("Create \"\(trimmed)\"", systemImage: ApexIcon.plus.systemName)
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.accent)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .listRowBackground(ApexColor.bgSurface)
            .accessibilityIdentifier("picker.create")
        }
    }

    private func subtitle(_ definition: ExerciseDefinition) -> String {
        var parts: [String] = []
        if let category = definition.category { parts.append(category.capitalized) }
        if definition.isUnilateral == true { parts.append("unilateral") }
        let defaults = [
            definition.defaultSets.flatMap { sets in definition.defaultReps.map { "\(sets) × \($0)" } },
            definition.defaultDuration, definition.defaultWeight, definition.defaultRest.map { "rest \($0)" },
        ].compactMap { $0 }
        if !defaults.isEmpty { parts.append(defaults.joined(separator: " · ")) }
        return parts.joined(separator: " · ")
    }
}
