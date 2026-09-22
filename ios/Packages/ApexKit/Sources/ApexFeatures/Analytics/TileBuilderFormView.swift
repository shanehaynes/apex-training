import ApexCore
import ApexUI
import SwiftUI

/// The tile builder's form, scrolling under the pinned preview.
///
/// ux-review §3.7 counted ~33 pills here before the preview. Chart (6),
/// bucket (4), preset (5) and display unit (5) are menus now — "where a value
/// has more than four options or is rarely changed, use a Picker" (§1.3) —
/// and the measure's ~20 chips have become one row that opens a searchable
/// sheet (`SeriesEditorView`). What is left above the series card is the
/// range's three chips: a value with three options, changed often enough that
/// a menu would cost a tap for nothing.
struct TileBuilderFormView: View {
    @Bindable var builder: TileBuilderModel

    private var draft: ChartDraft { builder.draft }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                FormField("Title", text: field(\.title), placeholder: "Weekly mileage", identifier: "analytics.builder.title")
                ChipRow("Chart", options: AnalyticsCatalog.chartTypes.map { ($0.value, $0.label) }, selection: field(\.chartType),
                        collapseAbove: 4, identifier: "analytics.builder.chart")
                ChipRow("Range", options: AnalyticsCatalog.rangeKinds.map { ($0.value, $0.label) }, selection: field(\.rangeKind), identifier: "analytics.builder.range")
                switch draft.rangeKind {
                case "rolling":
                    FormField("Days back", text: field(\.rollingDays), placeholder: "90", keyboard: .numberPad, identifier: "analytics.builder.days")
                case "preset":
                    MenuPicker("Preset", options: AnalyticsCatalog.presets.map { ($0.value, $0.label) }, selection: field(\.preset), identifier: "analytics.builder.preset")
                default:
                    HStack(spacing: Spacing.sm) {
                        DateField("From", day: dayBinding(\.startDate), identifier: "analytics.builder.from")
                        DateField("To (inclusive)", day: dayBinding(\.endDate), identifier: "analytics.builder.to")
                    }
                }
                if builder.showsBucket {
                    MenuPicker("Bucket", options: AnalyticsCatalog.buckets.map { ($0.value, $0.label) }, selection: field(\.bucket), identifier: "analytics.builder.bucket")
                }
                if builder.showsDisplayUnit {
                    MenuPicker("Display unit", options: [("", "As logged")] + AnalyticsCatalog.displayUnits.map { ($0, $0) },
                               selection: field(\.displayUnit), identifier: "analytics.builder.unit")
                }
                ForEach(Array(draft.series.enumerated()), id: \.element.id) { index, series in
                    SeriesEditorView(builder: builder, series: series, index: index)
                }
                if builder.canAddSeries {
                    Button { Motion.animate { builder.addSeries() } } label: {
                        Label("Add series", systemImage: ApexIcon.plus.systemName)
                            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(ApexColor.accent)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("analytics.builder.addseries")
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.top, Spacing.md)
            .padding(.bottom, Spacing.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("analytics.builder.form")
    }

    private func field(_ keyPath: WritableKeyPath<ChartDraft, String>) -> Binding<String> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in builder.update { $0[keyPath: keyPath] = value } })
    }

    /// `yyyy-MM-dd` in the draft ↔ a day in the picker; an empty field opens on today.
    private func dayBinding(_ keyPath: WritableKeyPath<ChartDraft, String>) -> Binding<DayKey> {
        Binding(
            get: { DayKey(draft[keyPath: keyPath]) ?? builder.model.today },
            set: { day in builder.update { $0[keyPath: keyPath] = day.string } }
        )
    }
}
