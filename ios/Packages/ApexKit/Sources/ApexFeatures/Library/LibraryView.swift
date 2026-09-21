import ApexCore
import ApexUI
import SwiftUI

/// The exercise library (`LibraryView.tsx`): search, category chips, rows
/// with last-performed and "in N workouts" — shown on the phone too (U11) —
/// and the archived section under a divider.
public struct LibraryView: View {
    @Bindable private var model: LibraryModel

    public init(model: LibraryModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                controls
                if model.isLoading, model.definitions.isEmpty {
                    ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity)
                } else if model.active.isEmpty, model.archived.isEmpty {
                    Text("No exercises match.").apexBody().accessibilityIdentifier("library.empty")
                } else {
                    rows(model.active)
                    if !model.archived.isEmpty {
                        archivedDivider
                        rows(model.archived)
                    }
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Exercise library")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: YouRoute.workoutLibrary) {
                    ApexIcon.template.image
                }
                .accessibilityLabel("Workout library")
                .accessibilityIdentifier("library.templates")
            }
        }
        .task { await model.start() }
        .refreshable { await model.reload() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library.root")
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(spacing: Spacing.sm) {
                ApexIcon.search.image.font(.system(size: 14)).foregroundStyle(ApexColor.textMuted)
                TextField("", text: $model.query, prompt: Text("Search exercises…").foregroundStyle(ApexColor.textMuted))
                    .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("library.search")
                if !model.query.isEmpty {
                    Button { model.query = "" } label: {
                        ApexIcon.close.image.font(.system(size: 13)).foregroundStyle(ApexColor.textMuted)
                            .frame(width: 32, height: 32).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .apexFieldChrome()
            ChipRow(
                options: LibraryModel.categories.map { ($0, $0 == "all" ? "All" : $0.capitalized) },
                selection: $model.category, identifier: "library.categories"
            )
            Text("\(model.active.count) exercise\(model.active.count == 1 ? "" : "s")")
                .apexEyebrow()
                .accessibilityIdentifier("library.count")
        }
    }

    /// Lazy: the library is every exercise the account knows, and the search
    /// field above re-evaluates this on each keystroke — eagerly that was the
    /// whole list built per character.
    private func rows(_ definitions: [ExerciseDefinition]) -> some View {
        SettingsSection(lazy: true) {
            ForEach(Array(definitions.enumerated()), id: \.element.id) { index, definition in
                if index > 0 { SettingsDivider() }
                NavigationLink(value: YouRoute.exercise(id: definition.id)) {
                    LibraryRow(
                        definition: definition,
                        last: model.lastPerformedLabel(definition),
                        references: model.referencesLabel(definition)
                    )
                }
                .buttonStyle(SettingsRowButtonStyle())
                .accessibilityIdentifier("library.row.\(definition.id)")
            }
        }
    }

    private var archivedDivider: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "archivebox").font(.system(size: 11))
            Text("Archived")
        }
        .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
        .foregroundStyle(ApexColor.textMuted)
        .textCase(.uppercase)
        .accessibilityIdentifier("library.archived")
    }
}

/// One library row: name, category · muscle groups, and the two stats.
struct LibraryRow: View {
    let definition: ExerciseDefinition
    let last: String?
    let references: String?

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(definition.canonicalName)
                    .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(1)
                Text(meta)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: 2) {
                if let last { Text(last) }
                if let references { Text(references) }
            }
            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
            .foregroundStyle(ApexColor.textSecondary)
            .lineLimit(1)
            ApexIcon.chevronRight.image.font(.system(size: 13, weight: .medium)).foregroundStyle(ApexColor.textMuted)
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var meta: String {
        var parts = [definition.category ?? ""].filter { !$0.isEmpty }
        if let groups = definition.muscleGroups, !groups.isEmpty { parts.append(groups.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}
