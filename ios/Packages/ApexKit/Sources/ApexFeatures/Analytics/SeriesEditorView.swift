import ApexCore
import ApexUI
import SwiftUI

/// `SeriesEditor` in `TileBuilder.tsx`: the grouped measure picker with its
/// dimming, then — once a measure is chosen — aggregation, split, top-N, the
/// grade scale, a Filters disclosure, and the series label.
struct SeriesEditorView: View {
    @Bindable var builder: TileBuilderModel
    let series: SeriesDraft
    let index: Int

    @State private var measureReason: String?

    private var measure: AnalyticsCatalog.Measure? { builder.measure(for: series) }
    private var id: String { series.id }
    private var filtersOpen: Bool { builder.filtersOpen.contains(id) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Series \(index + 1)").apexEyebrow()
                Spacer()
                if builder.draft.series.count > 1 {
                    Button { Motion.animate { builder.removeSeries(id) } } label: {
                        ApexIcon.close.image.font(.system(size: 13)).foregroundStyle(ApexColor.textMuted)
                            .frame(width: 44, height: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove series \(index + 1)")
                    .accessibilityIdentifier("series.\(id).remove")
                }
            }
            measures
            if let measure {
                if measure.allowedAggs.count > 1 {
                    ChipRow("Aggregation", options: [("", "Auto (\(measure.defaultAgg))")] + measure.allowedAggs.map { ($0, $0) },
                            selection: seriesField(\.agg), identifier: "series.\(id).agg")
                }
                if !measure.allowedGroupBys.isEmpty {
                    ChipRow("Split by", options: [("", "None")] + measure.allowedGroupBys.map { ($0, AnalyticsCatalog.groupByLabels[$0] ?? $0) },
                            selection: seriesField(\.groupBy), identifier: "series.\(id).groupby")
                }
                if !series.groupBy.isEmpty {
                    FormField("Top groups (optional, default \(AnalyticsCatalog.defaultGroupLimit))", text: seriesField(\.groupLimit), placeholder: "6", keyboard: .numberPad, identifier: "series.\(id).grouplimit")
                }
                if measure.source == "pitch-logs" {
                    ChipRow("Grade scale", options: (measure.id == "max-grade" ? [] : [("", "Any")]) + AnalyticsCatalog.gradeScales.map { ($0.value, $0.label) },
                            selection: seriesField(\.gradeScale), identifier: "series.\(id).gradescale")
                }
                Button {
                    Motion.animate {
                        if filtersOpen { builder.filtersOpen.remove(id) } else { builder.filtersOpen.insert(id) }
                    }
                } label: {
                    HStack(spacing: Spacing.xs) {
                        Text("Filters").apexFieldLabel()
                        ApexIcon.chevronDown.image.font(.system(size: 10)).foregroundStyle(ApexColor.textMuted)
                            .rotationEffect(.degrees(filtersOpen ? 0 : -90))
                    }
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("series.\(id).filters")
                if filtersOpen { filters(measure) }
                FormField("Series label (optional)", text: seriesField(\.label), identifier: "series.\(id).label")
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("series.\(id)")
    }

    /// The grouped measure picker: a measure a chosen sport rules out is dimmed,
    /// and a tap on it shows why instead of selecting.
    private var measures: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Measure").apexFieldLabel()
            ForEach(AnalyticsCatalog.measureGroups) { group in
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(group.label)
                        .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                        .foregroundStyle(ApexColor.textMuted)
                    FlowLayout(spacing: Spacing.xs) {
                        ForEach(group.ids, id: \.self) { measureId in
                            let reason = builder.measureDimReason(seriesId: id, measureId: measureId)
                            Chip(AnalyticsCatalog.measure(measureId)?.label ?? measureId, isSelected: series.measure == measureId, isDimmed: reason != nil) {
                                if let reason {
                                    Motion.animate { measureReason = reason }
                                } else {
                                    Motion.animate {
                                        measureReason = nil
                                        builder.setMeasure(id, measureId)
                                    }
                                }
                            }
                            .accessibilityAddTraits(series.measure == measureId ? .isSelected : [])
                            .accessibilityIdentifier("series.\(id).measure.\(measureId)")
                        }
                    }
                }
            }
            if let measureReason {
                Text(measureReason)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .accessibilityIdentifier("series.\(id).measure.reason")
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
