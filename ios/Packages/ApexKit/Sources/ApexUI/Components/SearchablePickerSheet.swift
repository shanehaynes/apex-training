import SwiftUI

/// A titled run of options inside a `SearchablePickerSheet` — the analytics
/// measures' four groups, an exercise library's letters. `title: nil` is an
/// untitled leading group.
public nonisolated struct PickerGroup<Value: Hashable>: Identifiable {
    public let title: String?
    public let options: [PickerOption<Value>]

    public init(_ title: String? = nil, options: [PickerOption<Value>]) {
        self.title = title
        self.options = options
    }

    public init(_ title: String? = nil, options: [(value: Value, label: String)]) {
        self.init(title, options: options.map { PickerOption($0.value, $0.label) })
    }

    /// Stable across a filter: the title, or the first option's value, so the
    /// untitled group keeps its identity when the query narrows it.
    public var id: String { title ?? "group.\(options.first.map { String(describing: $0.value) } ?? "empty")" }
}

extension PickerGroup: Sendable where Value: Sendable {}

/// The picker for a list too long to put in a menu (ux-review §3.7: the tile
/// builder's ~20 measures in four groups). A sheet with a search field over a
/// grouped list; a tap selects and dismisses.
///
/// Present it yourself — it sets its own detents:
///
/// ```swift
/// .sheet(isPresented: $picking) {
///     SearchablePickerSheet(title: "Measure", groups: groups, selection: draft.measure) { draft.measure = $0 }
/// }
/// ```
///
/// The list is a `ScrollView` of `SettingsSection`s, not `List(.insetGrouped)`,
/// for the reason already written on `SettingsSection`: the native inset-grouped
/// chrome cannot be recoloured far enough to sit on the warm charcoal. This is
/// the same shape the You tab draws, so the two read as one control.
public struct SearchablePickerSheet<Value: Hashable>: View {
    private let title: String
    private let groups: [PickerGroup<Value>]
    private let selection: Value?
    private let searchLabel: String
    private let searchPrompt: String
    private let emptyMessage: String
    private let identifier: String?
    private let onSelect: (Value) -> Void

    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    public init(
        title: String, groups: [PickerGroup<Value>], selection: Value? = nil,
        searchLabel: String = "Search", searchPrompt: String = "Search", emptyMessage: String = "No match for that search.",
        identifier: String? = nil, onSelect: @escaping (Value) -> Void
    ) {
        self.title = title
        self.groups = groups
        self.selection = selection
        self.searchLabel = searchLabel
        self.searchPrompt = searchPrompt
        self.emptyMessage = emptyMessage
        self.identifier = identifier
        self.onSelect = onSelect
    }

    /// One flat group, for the common case.
    public init(
        title: String, options: [(value: Value, label: String)], selection: Value? = nil,
        searchLabel: String = "Search", searchPrompt: String = "Search", emptyMessage: String = "No match for that search.",
        identifier: String? = nil, onSelect: @escaping (Value) -> Void
    ) {
        self.init(
            title: title, groups: [PickerGroup(nil, options: options)], selection: selection,
            searchLabel: searchLabel, searchPrompt: searchPrompt, emptyMessage: emptyMessage,
            identifier: identifier, onSelect: onSelect
        )
    }

    /// Case- and diacritic-insensitive substring match on the label, group order
    /// and option order untouched, groups left with nothing dropped. Static and
    /// pure so the filter is proved without a host application.
    public nonisolated static func filter(_ groups: [PickerGroup<Value>], query: String) -> [PickerGroup<Value>] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return groups }
        return groups.compactMap { group in
            let hits = group.options.filter {
                $0.label.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
            return hits.isEmpty ? nil : PickerGroup(group.title, options: hits)
        }
    }

    private var resolvedIdentifier: String {
        identifier ?? "picker-sheet.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))"
    }

    private var visible: [PickerGroup<Value>] { Self.filter(groups, query: query) }

    public var body: some View {
        VStack(spacing: Spacing.lg) {
            SheetHeader(title: title) { dismiss() }
            FormField(searchLabel, text: $query, placeholder: searchPrompt, identifier: "\(resolvedIdentifier).search")
                .padding(.horizontal, Spacing.screen)
            if visible.isEmpty {
                EmptyState(eyebrow: "Nothing found", message: emptyMessage, symbol: ApexIcon.search.systemName)
                    .accessibilityIdentifier("\(resolvedIdentifier).empty")
            } else {
                list
            }
        }
        .background(ApexColor.bgPrimary)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier(resolvedIdentifier)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.xl) {
                ForEach(visible) { group in
                    SettingsSection(group.title, lazy: true) {
                        ForEach(Array(group.options.enumerated()), id: \.element.id) { index, option in
                            if index > 0 { SettingsDivider() }
                            row(option)
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.bottom, Spacing.xl)
        }
    }

    private func row(_ option: PickerOption<Value>) -> some View {
        let isSelected = option.value == selection
        return Button {
            onSelect(option.value)
            dismiss()
        } label: {
            SettingsRow(option.label, showsChevron: false) {
                if isSelected {
                    ApexIcon.check.image
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(ApexColor.accent)
                }
            }
        }
        .buttonStyle(SettingsRowButtonStyle())
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("\(resolvedIdentifier).option.\(slug(option.label))")
    }

    private func slug(_ label: String) -> String {
        label.lowercased().replacingOccurrences(of: " ", with: "-")
    }
}
