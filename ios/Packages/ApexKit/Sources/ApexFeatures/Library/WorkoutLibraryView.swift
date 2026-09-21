import ApexCore
import ApexUI
import SwiftUI

/// The workout library (`TemplateSearch.tsx`'s list, as its own screen):
/// saved workouts newest first, each with its type and size, and Archive /
/// Restore — the web only archives; the builder revives a title by reuse.
public struct WorkoutLibraryView: View {
    private let model: LibraryModel

    public init(model: LibraryModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Every workout you have applied from the builder. Repeats of the same workout share one PR history.")
                if model.templates.isEmpty {
                    Text("Nothing saved yet — build a workout and Apply saves it here for next time.")
                        .apexBody()
                        .accessibilityIdentifier("library.templates.empty")
                } else {
                    rows(model.activeTemplates, archived: false)
                    if !model.archivedTemplates.isEmpty {
                        Text("Archived").apexEyebrow()
                        rows(model.archivedTemplates, archived: true)
                    }
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Workout library")
        .task { await model.start() }
        .refreshable { await model.reload() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library.templates.root")
    }

    /// Lazy: every workout ever applied from the builder, with no ceiling.
    private func rows(_ templates: [WorkoutTemplate], archived: Bool) -> some View {
        SettingsSection(lazy: true) {
            ForEach(Array(templates.enumerated()), id: \.element.id) { index, template in
                if index > 0 { SettingsDivider() }
                HStack(alignment: .center, spacing: Spacing.md) {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text(template.title)
                            .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                            .foregroundStyle(archived ? ApexColor.textSecondary : ApexColor.textPrimary)
                            .lineLimit(2)
                        HStack(spacing: Spacing.sm) {
                            TypeChip(rawType: template.type.rawValue)
                            let meta = LibraryModel.templateMeta(template)
                            if !meta.isEmpty {
                                Text(meta)
                                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                    .foregroundStyle(ApexColor.textMuted)
                                    .lineLimit(1)
                            }
                        }
                    }
                    Spacer(minLength: Spacing.sm)
                    Button(archived ? "Restore" : "Archive") {
                        Task { await model.archiveTemplate(template, archived: !archived) }
                    }
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.accent)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("library.template.archive.\(template.id)")
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.md)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("library.template.\(template.id)")
            }
        }
    }
}
