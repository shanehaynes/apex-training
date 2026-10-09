import ApexCore
import ApexUI
import SwiftUI

/// `CreateDefinitionInline.tsx`: the library's inline create — a row that
/// opens into category + unilateral — shared by the exercise picker (add,
/// swap) and the Library screen, so a movement is added the same way wherever
/// its name comes up missing. Row chrome (list background, padding) is the
/// host's.
struct CreateDefinitionRow: View {
    /// The trimmed query — what the new definition is called.
    let name: String
    let categories: [(value: String, label: String)]
    /// Near matches are on screen above: the create is the override.
    let anyway: Bool
    let confirmLabel: String
    /// `picker` or `library`: `<prefix>.create`, `.create.category`, …
    let identifierPrefix: String
    let onCreate: (String, String, Bool) async -> ExerciseDefinition?
    let onCreated: (ExerciseDefinition) -> Void

    @State private var creating: Bool
    @State private var category: String
    @State private var unilateral = false
    @State private var busy = false

    init(
        name: String, categories: [(value: String, label: String)], initialCategory: String, anyway: Bool,
        confirmLabel: String, identifierPrefix: String, startsOpen: Bool = false,
        onCreate: @escaping (String, String, Bool) async -> ExerciseDefinition?,
        onCreated: @escaping (ExerciseDefinition) -> Void
    ) {
        self.name = name
        self.categories = categories
        self.anyway = anyway
        self.confirmLabel = confirmLabel
        self.identifierPrefix = identifierPrefix
        self.onCreate = onCreate
        self.onCreated = onCreated
        _creating = State(initialValue: startsOpen)
        _category = State(initialValue: initialCategory)
    }

    var body: some View {
        if creating {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("New exercise: \(name)")
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                ChipRow("Category", options: categories, selection: $category, identifier: "\(identifierPrefix).create.category")
                Toggle("Unilateral (counts per side)", isOn: $unilateral)
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .tint(ApexColor.accent)
                    .accessibilityIdentifier("\(identifierPrefix).create.unilateral")
                HStack(spacing: Spacing.sm) {
                    ApexButton("Back", kind: .secondary) { creating = false }
                    ApexButton(confirmLabel, isLoading: busy) {
                        busy = true
                        Task {
                            if let created = await onCreate(name, category, unilateral || Entries.hasPerSideCount(name)) {
                                onCreated(created)
                            }
                            busy = false
                        }
                    }
                    .accessibilityIdentifier("\(identifierPrefix).create.confirm")
                }
            }
            .padding(.vertical, Spacing.sm)
        } else {
            Button { creating = true } label: {
                Label(anyway ? "Create \"\(name)\" anyway" : "Create \"\(name)\"", systemImage: ApexIcon.plus.systemName)
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.accent)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("\(identifierPrefix).create")
        }
    }
}
