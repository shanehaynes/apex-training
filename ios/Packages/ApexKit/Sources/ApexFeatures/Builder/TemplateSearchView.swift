import ApexCore
import ApexUI
import SwiftUI

/// `TemplateSearch.tsx`: substring over title and tags, the type chips, the
/// library newest first, swipe to archive, and "Build '<q>'" at the bottom.
struct TemplateSearchView: View {
    @Bindable var builder: BuilderModel
    @FocusState private var searching: Bool

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    ApexIcon.search.image.font(.system(size: 14)).foregroundStyle(ApexColor.textMuted)
                    TextField("", text: $builder.query, prompt: Text("Search your library, or name a new workout").foregroundStyle(ApexColor.textMuted))
                        .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { if builder.filteredTemplates.isEmpty { builder.startBlank() } }
                        .focused($searching)
                        .accessibilityIdentifier("builder.search")
                }
                .apexFieldChrome()
                FlowLayout(spacing: Spacing.xs) {
                    Chip("All", isSelected: builder.typeFilter == nil) { builder.typeFilter = nil }
                    ForEach(WorkoutDraft.typeOrder, id: \.rawValue) { type in
                        Chip(WorkoutDraft.label(for: type), isSelected: builder.typeFilter == type) {
                            builder.typeFilter = builder.typeFilter == type ? nil : type
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.md)

            List {
                if builder.filteredTemplates.isEmpty {
                    Text(builder.templates.isEmpty
                         ? "Your library is empty. Build a workout and Apply saves it here."
                         : "Nothing matches — build it fresh below.")
                        .apexBody()
                        .listRowBackground(ApexColor.bgSurface)
                }
                ForEach(builder.filteredTemplates, id: \.id) { template in
                    Button { builder.pick(template) } label: { row(template) }
                        .buttonStyle(.plain)
                        .listRowBackground(ApexColor.bgSurface)
                        .listRowSeparatorTint(ApexColor.borderSubtle)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { Task { await builder.archive(template) } } label: {
                                Label("Remove", systemImage: ApexIcon.trash.systemName)
                            }
                        }
                        .accessibilityIdentifier("builder.template.\(template.id)")
                }
                Button { builder.startBlank() } label: {
                    Label(builder.query.trimmingCharacters(in: .whitespaces).isEmpty ? "Build a new workout" : "Build \"\(builder.query.trimmingCharacters(in: .whitespaces))\"",
                          systemImage: ApexIcon.plus.systemName)
                        .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                        .foregroundStyle(ApexColor.accent)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .listRowBackground(ApexColor.bgSurface)
                .accessibilityIdentifier("builder.new")
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear { searching = true }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("builder.search.step")
    }

    private func row(_ template: WorkoutTemplate) -> some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            RoundedRectangle(cornerRadius: 2).fill(WorkoutTypeTokens.palette(for: template.type.rawValue).solid).frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                Text(template.title)
                    .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                HStack(spacing: Spacing.sm) {
                    TypeChip(rawType: template.type.rawValue)
                    if let badge = scoringBadge(template) {
                        Text(badge).font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2)).foregroundStyle(ApexColor.textSecondary)
                    }
                    let count = (template.warmup?.count ?? 0) + (template.exercises?.count ?? 0) + (template.cooldown?.count ?? 0)
                    Text("\(count) exercise\(count == 1 ? "" : "s")")
                        .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                        .foregroundStyle(ApexColor.textMuted)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .contentShape(.rect)
    }

    private func scoringBadge(_ template: WorkoutTemplate) -> String? {
        switch template.scoringType {
        case "for-time": "For Time"
        case "amrap": template.timeCapMinutes.map { "AMRAP \($0) min" } ?? "AMRAP"
        default: nil
        }
    }
}
