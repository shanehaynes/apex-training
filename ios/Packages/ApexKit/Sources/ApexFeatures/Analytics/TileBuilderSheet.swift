import ApexCore
import ApexUI
import SwiftUI

/// The tile builder (`TileBuilder.tsx`): the form over a live preview the
/// server computes, the coach drawer under a sparkle, Save in a bottom bar the
/// keyboard lifts (U3). `.large` only; a dirty draft cannot be swiped away
/// (architecture §3).
public struct TileBuilderSheet: View {
    let onClose: () -> Void
    @State private var builder: TileBuilderModel

    public init(model: AnalyticsModel, tile: AnalyticsTile?, coachServices: CoachServices? = nil, onClose: @escaping () -> Void) {
        self.onClose = onClose
        _builder = State(initialValue: TileBuilderModel(model: model, tile: tile, coachServices: coachServices))
    }

    /// Over a prepared model — previews and snapshots open the sheet mid-flow.
    public init(builder: TileBuilderModel, onClose: @escaping () -> Void) {
        self.onClose = onClose
        _builder = State(initialValue: builder)
    }

    public var body: some View {
        @Bindable var builder = builder
        VStack(spacing: 0) {
            header
            if builder.coachOpen, let coach = builder.coach {
                VSplit(top: { TileBuilderFormView(builder: builder) }, bottom: { DraftCoachDrawer(coach: coach, copy: .analytics) })
            } else {
                TileBuilderFormView(builder: builder)
            }
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .interactiveDismissDisabled(builder.isDirty)
        .confirmationDialog("Discard this tile?", isPresented: $builder.confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive, action: onClose)
            Button("Keep editing", role: .cancel) {}
        }
        .task { await builder.start() }
        .onDisappear { builder.shutdown() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("analytics.builder")
    }

    private var header: some View {
        HStack(spacing: Spacing.sm) {
            Text(builder.title).apexTitle().lineLimit(1).accessibilityIdentifier("analytics.builder.heading")
            Spacer(minLength: 0)
            if builder.canCoach {
                Button { withAnimation(Motion.spring) { builder.coachOpen.toggle() } } label: {
                    ApexIcon.sparkles.image
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(builder.coachOpen ? ApexColor.bgPrimary : ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .background(builder.coachOpen ? ApexColor.accent : .clear, in: .circle)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(builder.coachOpen ? "Hide coach" : "Ask your coach to configure the tile")
                .accessibilityIdentifier("analytics.builder.coach.toggle")
            }
            Button {
                if builder.isDirty { builder.confirmDiscard = true } else { onClose() }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("analytics.builder.close")
        }
        .padding(.leading, Spacing.screen)
        .padding(.trailing, Spacing.xs)
        .padding(.top, Spacing.sm)
    }

    private var actionBar: some View {
        HStack(spacing: Spacing.sm) {
            ApexButton("Cancel", kind: .secondary) {
                if builder.isDirty { builder.confirmDiscard = true } else { onClose() }
            }
            .disabled(builder.isSaving)
            ApexButton(builder.isEditing ? "Save changes" : "Save tile", isLoading: builder.isSaving) {
                Task { if await builder.save() { onClose() } }
            }
            .accessibilityIdentifier("analytics.builder.save")
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }
}

/// The config column and the preview, stacked for the phone.
struct TileBuilderFormView: View {
    @Bindable var builder: TileBuilderModel

    private var draft: ChartDraft { builder.draft }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                FormField("Title", text: field(\.title), placeholder: "Weekly mileage", identifier: "analytics.builder.title")
                ChipRow("Chart", options: AnalyticsCatalog.chartTypes.map { ($0.value, $0.label) }, selection: field(\.chartType), identifier: "analytics.builder.chart")
                ChipRow("Range", options: AnalyticsCatalog.rangeKinds.map { ($0.value, $0.label) }, selection: field(\.rangeKind), identifier: "analytics.builder.range")
                switch draft.rangeKind {
                case "rolling":
                    FormField("Days back", text: field(\.rollingDays), placeholder: "90", keyboard: .numberPad, identifier: "analytics.builder.days")
                case "preset":
                    ChipRow("Preset", options: AnalyticsCatalog.presets.map { ($0.value, $0.label) }, selection: field(\.preset), identifier: "analytics.builder.preset")
                default:
                    HStack(spacing: Spacing.sm) {
                        DateField("From", day: dayBinding(\.startDate), identifier: "analytics.builder.from")
                        DateField("To (inclusive)", day: dayBinding(\.endDate), identifier: "analytics.builder.to")
                    }
                }
                if builder.showsBucket {
                    ChipRow("Bucket", options: AnalyticsCatalog.buckets.map { ($0.value, $0.label) }, selection: field(\.bucket), identifier: "analytics.builder.bucket")
                }
                if builder.showsDisplayUnit {
                    ChipRow("Display unit", options: [("", "As logged")] + AnalyticsCatalog.displayUnits.map { ($0, $0) }, selection: field(\.displayUnit), identifier: "analytics.builder.unit")
                }
                ForEach(Array(draft.series.enumerated()), id: \.element.id) { index, series in
                    SeriesEditorView(builder: builder, series: series, index: index)
                }
                if builder.canAddSeries {
                    Button { withAnimation(Motion.spring) { builder.addSeries() } } label: {
                        Label("Add series", systemImage: ApexIcon.plus.systemName)
                            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(ApexColor.accent)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("analytics.builder.addseries")
                }
                preview
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.top, Spacing.md)
            .padding(.bottom, Spacing.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("analytics.builder.form")
    }

    /// The live preview: the server's chart, or its problem in the web's words.
    private var preview: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text("Preview").apexFieldLabel()
                Spacer()
                if builder.preview == .loading {
                    ProgressView().controlSize(.mini).tint(ApexColor.textMuted)
                }
            }
            Group {
                switch builder.preview {
                case .idle, .loading:
                    Color.clear
                case .ready(let data):
                    TileBodyView(chartType: draft.chartType, data: data)
                        .accessibilityIdentifier("analytics.builder.preview")
                case .problem(let text):
                    TileProblemView(text: text)
                        .accessibilityIdentifier("analytics.builder.problem")
                case .failed(let text):
                    TileProblemView(text: text)
                        .accessibilityIdentifier("analytics.builder.failed")
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: draft.chartType == "kpi" ? TileHeight.small.points : TileHeight.medium.points)
            .padding(Spacing.md)
            .background(ApexColor.bgPrimary, in: .rect(cornerRadius: Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        }
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
