import ApexCore
import ApexUI
import SwiftUI

/// `SeriesEditor` in `TileBuilder.tsx`: the measure, and under a "More"
/// disclosure everything that qualifies it — aggregation, the split, the top-N
/// cap, the grade scale, the filters and the series label.
///
/// ux-review §3.7: the measure was ~20 chips in four groups, the single
/// biggest run of pills in the app, and everything that qualifies it was laid
/// out underneath whether or not it had been touched. The measure is one row
/// that opens a searchable sheet; the rest opens itself only when a draft
/// already carries one of those values, so an edit form can never hide a
/// setting the user cannot then see.
struct SeriesEditorView: View {
    @Bindable var builder: TileBuilderModel
    let series: SeriesDraft
    let index: Int

    /// nil = follow the draft; a tap latches the user's choice. Latching
    /// rather than seeding a `Bool` keeps the disclosure honest when the coach
    /// fills the form after the view is on screen.
    @State private var moreOpenOverride: Bool?
    @State private var picking = false

    private var measure: AnalyticsCatalog.Measure? { builder.measure(for: series) }
    private var id: String { series.id }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            // One series needs no heading: "Measure" already names it, and
            // there is nothing to remove it from.
            if builder.draft.series.count > 1 {
                HStack {
                    Text("Series \(index + 1)").apexEyebrow()
                    Spacer()
                    Button { Motion.animate { builder.removeSeries(id) } } label: {
                        ApexIcon.close.image.font(.system(size: 13)).foregroundStyle(ApexColor.textMuted)
                            .frame(width: 44, height: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove series \(index + 1)")
                    .accessibilityIdentifier("series.\(id).remove")
                }
            }
            measureRow
            if measure != nil { more }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .sheet(isPresented: $picking) {
            MeasurePickerSheet(
                seriesId: id,
                selection: series.measure,
                dimReason: { builder.measureDimReason(seriesId: id, measureId: $0) },
                onSelect: { builder.setMeasure(id, $0) }
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("series.\(id)")
    }

    // MARK: - Measure

    /// A `MenuPicker`-shaped row: the same field box, the same chevron — it
    /// opens a sheet rather than a menu because twenty options in four groups
    /// is a list, not a menu (ux-review §3.7).
    private var measureRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Measure").apexFieldLabel()
            Button { picking = true } label: {
                HStack(spacing: Spacing.sm) {
                    Text(measure?.label ?? "Choose a measure")
                        .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(measure == nil ? ApexColor.textMuted : ApexColor.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.sm)
                    ApexIcon.chevronDown.image
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ApexColor.textMuted)
                }
                .apexFieldChrome()
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Measure")
            .accessibilityValue(measure?.label ?? "None")
            .accessibilityIdentifier("series.\(id).measure")
        }
    }

    // MARK: - More

    private var isMoreOpen: Bool { moreOpenOverride ?? (hasAdvanced || builder.filtersOpen.contains(id)) }

    /// Anything under the disclosure that is not at `SeriesDraft.empty`'s
    /// default. Computed from the draft on every read rather than stored, so a
    /// coach reduce opens the section the same way a loaded tile does.
    private var hasAdvanced: Bool {
        !series.agg.isEmpty
            || !series.groupBy.isEmpty
            || !series.groupLimit.isEmpty
            || !series.gradeScale.isEmpty
            || !series.label.isEmpty
            || series.dayFilterOffset != "0"
            || series.dayFilterMode != "include"
            || TileBuilderModel.hasFilters(series)
    }

    @ViewBuilder
    private var more: some View {
        Button {
            Motion.animate { moreOpenOverride = !isMoreOpen }
        } label: {
            HStack(spacing: Spacing.sm) {
                Text("More").apexFieldLabel()
                ApexIcon.chevronDown.image
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ApexColor.textMuted)
                    .rotationEffect(.degrees(isMoreOpen ? 0 : -90))
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("More")
        .accessibilityValue(isMoreOpen ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("series.\(id).more")
        if isMoreOpen, let measure {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if measure.allowedAggs.count > 1 {
                    ChipRow("Aggregation", options: [("", "Auto (\(measure.defaultAgg))")] + measure.allowedAggs.map { ($0, $0) },
                            selection: seriesField(\.agg), collapseAbove: 4, identifier: "series.\(id).agg")
                }
                if !measure.allowedGroupBys.isEmpty {
                    ChipRow("Split by", options: [("", "None")] + measure.allowedGroupBys.map { ($0, AnalyticsCatalog.groupByLabels[$0] ?? $0) },
                            selection: seriesField(\.groupBy), collapseAbove: 4, identifier: "series.\(id).groupby")
                }
                if !series.groupBy.isEmpty {
                    FormField("Top groups (optional, default \(AnalyticsCatalog.defaultGroupLimit))", text: seriesField(\.groupLimit), placeholder: "6", keyboard: .numberPad, identifier: "series.\(id).grouplimit")
                }
                if measure.source == "pitch-logs" {
                    ChipRow("Grade scale", options: (measure.id == "max-grade" ? [] : [("", "Any")]) + AnalyticsCatalog.gradeScales.map { ($0.value, $0.label) },
                            selection: seriesField(\.gradeScale), collapseAbove: 4, identifier: "series.\(id).gradescale")
                }
                filters(measure)
                FormField("Series label (optional)", text: seriesField(\.label), identifier: "series.\(id).label")
            }
        }
    }

    @ViewBuilder
    private func filters(_ measure: AnalyticsCatalog.Measure) -> some View {
        let show = builder.filterVisibility(for: series)
        VStack(alignment: .leading, spacing: Spacing.md) {
            if show.eventTypes {
                MultiChipRow("Workout types", options: AnalyticsCatalog.workoutTypes.map { ($0.value, $0.label) }, values: series.eventTypes,
                             tint: { WorkoutTypeTokens.palette(for: $0).border }, identifier: "series.\(id).types") { builder.toggle(id, \.eventTypes, $0) }
            }
            if show.sports {
                MultiChipRow("Sports", options: AnalyticsCatalog.sports.map { ($0.value, $0.label) }, values: series.sports,
                             dimmed: { builder.sportDimReason(seriesId: id, sport: $0) != nil },
                             dimReason: "Incompatible with \(measure.label)", identifier: "series.\(id).sports") { builder.toggle(id, \.sports, $0) }
                if series.sports.contains("other") {
                    if builder.options.otherWorkoutTitles.isEmpty {
                        Text(AnalyticsCatalog.otherSportHint)
                            .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                            .accessibilityIdentifier("series.\(id).otherhint")
                    } else {
                        MultiChipRow("Which workouts", options: builder.options.otherWorkoutTitles.map { ($0, $0) }, values: series.workoutTitles,
                                     identifier: "series.\(id).workouts") { builder.toggle(id, \.workoutTitles, $0) }
                    }
                }
            }
            if show.logs {
                FormField("Exercises (comma-separated, optional)", text: Binding(
                    get: { series.exerciseNames.joined(separator: ", ") },
                    set: { builder.setExerciseNames(id, text: $0) }
                ), placeholder: "Bench Press, Squat", identifier: "series.\(id).exercises")
                if !builder.options.categories.isEmpty {
                    MultiChipRow("Categories", options: builder.options.categories.map { ($0, $0) }, values: series.categories,
                                 identifier: "series.\(id).categories") { builder.toggle(id, \.categories, $0) }
                }
            }
            if show.meals {
                MultiChipRow("Meal types", options: AnalyticsCatalog.mealTypes.map { ($0, $0) }, values: series.mealTypes,
                             identifier: "series.\(id).mealtypes") { builder.toggle(id, \.mealTypes, $0) }
            }
            MultiChipRow("Only days near a workout of…", options: AnalyticsCatalog.workoutTypes.map { ($0.value, $0.label) }, values: series.dayFilterTypes,
                         tint: { WorkoutTypeTokens.palette(for: $0).border }, identifier: "series.\(id).daytypes") { builder.toggle(id, \.dayFilterTypes, $0) }
            if !series.dayFilterTypes.isEmpty {
                FormField("Offset days (-7…7; 1 = day after)", text: seriesField(\.dayFilterOffset), placeholder: "0", keyboard: .numbersAndPunctuation, identifier: "series.\(id).offset")
                ChipRow("Mode", options: AnalyticsCatalog.dayFilterModes.map { ($0.value, $0.label) }, selection: seriesField(\.dayFilterMode), identifier: "series.\(id).mode")
            }
        }
        .padding(.leading, Spacing.sm)
        .overlay(alignment: .leading) { Rectangle().fill(ApexColor.borderSubtle).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("series.\(id).filterrows")
    }

    private func seriesField(_ keyPath: WritableKeyPath<SeriesDraft, String>) -> Binding<String> {
        Binding(
            get: { builder.draft.series.first { $0.id == id }?[keyPath: keyPath] ?? "" },
            set: { value in builder.updateSeries(id) { $0[keyPath: keyPath] = value } }
        )
    }
}

/// The measure picker: `SearchablePickerSheet`'s shape — sheet, house search
/// field, grouped rows, a tap selects and dismisses — drawn here rather than
/// with the primitive because these rows need two things it does not offer:
///
/// 1. an identifier keyed by the measure id (`series.s1.measure.tonnage`), the
///    name the web, the smoke and every other agent already use. The
///    primitive slugs the *label*, which would rename two thirds of the family
///    ("Sessions" → `…measure.sessions`, not `session-count`);
/// 2. the dimming a chosen sport imposes — a measure that cannot mean anything
///    for the sports already filtered on says so in place of a checkmark,
///    which is what the chips did and what the web does.
///
/// The search filter is the primitive's own static one, so the two narrow
/// identically. Give `SearchablePickerSheet` an option-identifier hook and a
/// per-option disabled reason and this collapses into it.
struct MeasurePickerSheet: View {
    let seriesId: String
    let selection: String
    let dimReason: (String) -> String?
    let onSelect: (String) -> Void

    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    private var groups: [PickerGroup<String>] {
        AnalyticsCatalog.measureGroups.map { group in
            PickerGroup(group.label, options: group.ids.map { PickerOption($0, AnalyticsCatalog.measure($0)?.label ?? $0) })
        }
    }

    private var visible: [PickerGroup<String>] { SearchablePickerSheet<String>.filter(groups, query: query) }

    var body: some View {
        VStack(spacing: Spacing.lg) {
            SheetHeader(title: "Measure") { dismiss() }
            FormField("Search", text: $query, placeholder: "Search measures", identifier: "series.\(seriesId).measure.search")
                .padding(.horizontal, Spacing.screen)
            if visible.isEmpty {
                EmptyState(eyebrow: "Nothing found", message: "No measure matches that search.", symbol: ApexIcon.search.systemName)
                    .accessibilityIdentifier("series.\(seriesId).measure.empty")
            } else {
                list
            }
        }
        .background(ApexColor.bgPrimary)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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

    private func row(_ option: PickerOption<String>) -> some View {
        let reason = dimReason(option.value)
        let isSelected = option.value == selection
        return Button {
            guard reason == nil else { return }
            onSelect(option.value)
            dismiss()
        } label: {
            SettingsRow(option.label, showsChevron: false) {
                if let reason {
                    Text(reason)
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                } else if isSelected {
                    ApexIcon.check.image
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(ApexColor.accent)
                }
            }
            .opacity(reason == nil ? 1 : 0.5)
        }
        .buttonStyle(SettingsRowButtonStyle())
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("series.\(seriesId).measure.\(option.value)")
    }
}
