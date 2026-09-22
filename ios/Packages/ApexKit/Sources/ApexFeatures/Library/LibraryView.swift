import ApexCore
import ApexUI
import SwiftUI

/// The Library screen the You tab's one "Library" row pushes (ux-review §3.8):
/// a two-segment host over the exercise library and the workout library, which
/// used to be two rows of a five-row Training group. The segment is the whole
/// of the regroup — both screens, both routes and every identifier under them
/// are unchanged.
public struct LibraryHomeView: View {
    public nonisolated enum Tab: Hashable, Sendable { case exercises, workouts }

    private let model: LibraryModel
    @State private var tab: Tab

    /// `tab` lets a snapshot open on the Workouts segment; the screen itself
    /// always opens on Exercises.
    public init(model: LibraryModel, tab: Tab = .exercises) {
        self.model = model
        _tab = State(initialValue: tab)
    }

    public var body: some View {
        VStack(spacing: 0) {
            ApexSegmented(
                selection: $tab,
                options: [(Tab.exercises, "Exercises"), (Tab.workouts, "Workouts")]
            )
            .padding(.horizontal, Spacing.screen)
            .padding(.bottom, Spacing.sm)
            // The control that reaches the workout library, and so the
            // identifier the old "Workout library" row carried.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("library.templates")

            switch tab {
            case .exercises: LibraryView(model: model)
            case .workouts: WorkoutLibraryView(model: model)
            }
        }
        .youScreen("Library")
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library.home")
    }
}

/// The exercise library (`LibraryView.tsx`): search in the navigation bar,
/// category chips once there are enough rows to need filtering, rows with the
/// name over its category and stats — shown on the phone too (U11) — and the
/// archived section under a divider.
public struct LibraryView: View {
    @Bindable private var model: LibraryModel

    /// ux-review §3.8: filter controls over a short list are clutter. Seven
    /// category chips earn their place at the seeded stack's 69 rows and not
    /// at the dozen a new account has.
    private static let chipThreshold = 12

    public init(model: LibraryModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                if model.definitions.count > Self.chipThreshold {
                    ChipRow(
                        options: LibraryModel.categories.map { ($0, $0 == "all" ? "All" : $0.capitalized) },
                        selection: $model.category, identifier: "library.categories"
                    )
                }
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
        .searchable(
            text: $model.query, placement: .navigationBarDrawer(displayMode: .always),
            prompt: Text("Search exercises")
        )
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .searchFieldIdentifier("library.search")
        .task { await model.start() }
        .refreshable { await model.reload() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library.root")
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

/// One library row: the name on its own full-width line, then category ·
/// muscle groups and the two stats beneath it. The stats used to be a trailing
/// column claiming ~40% of the row, which truncated every long name at the
/// seeded stack's density (ux-review §5, "Adductor Stretch — L…").
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
                if !meta.isEmpty {
                    Text(meta)
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .lineLimit(1)
                }
                if !stats.isEmpty {
                    Text(stats)
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: Spacing.sm)
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

    private var stats: String {
        [last, references].compactMap { $0 }.joined(separator: " · ")
    }
}

extension View {
    /// `.searchable` is drawn by UIKit's `UISearchBar`, and SwiftUI offers no
    /// hook for naming its text field: an `accessibilityIdentifier` on the
    /// searchable view lands on the content below it, not on the bar. XCUITest
    /// reaches the field by name (`library.search`), so the bar is named
    /// through UIKit once it is in a window.
    func searchFieldIdentifier(_ identifier: String) -> some View {
        background(SearchFieldNamer(identifier: identifier).frame(width: 0, height: 0))
    }
}

private struct SearchFieldNamer: UIViewRepresentable {
    let identifier: String

    func makeUIView(context: Context) -> UIView { UIView(frame: .zero) }

    /// The bar is installed by the navigation controller, which may not have
    /// happened by the first update — hence the short retry rather than one
    /// shot.
    func updateUIView(_ view: UIView, context: Context) {
        let identifier = self.identifier
        Task { @MainActor in
            for _ in 0..<10 {
                if let window = view.window, let bar = Self.searchBar(in: window) {
                    bar.accessibilityIdentifier = identifier
                    bar.searchTextField.accessibilityIdentifier = identifier
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private static func searchBar(in root: UIView) -> UISearchBar? {
        if let bar = root as? UISearchBar { return bar }
        for child in root.subviews {
            if let bar = searchBar(in: child) { return bar }
        }
        return nil
    }
}
