import Accessibility
import ApexCore
import ApexUI
import Charts
import SwiftUI

/// `TileRenderer.tsx` in Swift Charts (design-spec §7): no axis lines, no
/// tick lines, no grid, no animation; mono ticks in `textMuted`; line 1.5,
/// points only when ≤ 60 buckets; area at 0.18; a legend only past one
/// series. Buckets are categorical (`bucket.key` on the axis, labelled by
/// `bucket.label`); a `nil` point is a gap. Swift Charts has no second
/// y-axis, so right-axis series are rescaled into the left domain and the
/// trailing axis labels are scaled back — one chart, one plot, aligned.
/// Value inspection is a tap or a hold-then-drag that shows a card — never a hover (U13).
public struct TileChartView: View {
    /// `nonisolated` so `TileChartDescriptor`, which is outside the module's
    /// default main-actor isolation, can switch on it.
    public nonisolated enum Kind: String, Sendable {
        case line, area, bar
        case stackedBar = "stacked-bar"
    }

    let kind: Kind
    let data: TileData

    @State private var scrubKey: String?

    public init(kind: Kind, data: TileData) {
        self.kind = kind
        self.data = data
    }

    /// One plotted point: series, bucket, value. `run` splits a series at
    /// its gaps so the line breaks instead of bridging them.
    private struct Point: Identifiable {
        let id: String
        let seriesKey: String
        let seriesIndex: Int
        let bucketKey: String
        let value: Double
        let run: Int
    }

    private var colors: [SeriesColor] { SeriesColors.assign(keys: data.series.map(\.key)) }
    private var bucketKeys: [String] { data.buckets.map(\.key) }
    private var isGrade: Bool { data.series.contains { $0.unitKind == "grade" } }
    private var showsPoints: Bool { data.buckets.count <= 60 }
    private var rightSeries: Set<Int> { Set(data.series.indices.filter { data.series[$0].axis == "right" }) }
    private var hasRightAxis: Bool { !rightSeries.isEmpty }

    /// The largest value on each axis — the rescaling ratio between them.
    private func axisMax(right: Bool) -> Double {
        let values = data.series.indices.filter { rightSeries.contains($0) == right }
            .flatMap { data.series[$0].points.compactMap { $0 } }
        return max(values.max() ?? 0, 1)
    }
    private var rightToLeft: Double { axisMax(right: false) / axisMax(right: true) }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if data.series.count > 1 { legend }
            chart
            .overlay(alignment: .top) {
                if let scrubKey, let index = bucketKeys.firstIndex(of: scrubKey) {
                    ScrubCard(
                        title: data.buckets[index].label.isEmpty ? (data.rangeLabel ?? "") : data.buckets[index].label,
                        rows: data.series.indices.map { i in
                            (label: data.series[i].label, value: TileFormat.value(data.series[i], at: index), color: ChartPalette.color(for: colors[i]))
                        }
                    )
                    .padding(.top, Spacing.xs)
                    .transition(.opacity)
                }
            }
        }
        // `.contain` alone left a VoiceOver user with the tile's title and then
        // silence: a Swift Chart publishes nothing on its own. The label is the
        // shape of the data in one sentence (the same summary `StreamChartsView`
        // gives its activity charts), and the descriptor is the chart rotor —
        // axes, series and every bucket by name, so the numbers can be walked
        // rather than guessed at.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(descriptor.summary)
        .accessibilityChartDescriptor(descriptor)
        .accessibilityIdentifier("tile.chart.\(kind.rawValue)")
    }

    private var descriptor: TileChartDescriptor { TileChartDescriptor(kind: kind, data: data) }

    private var legend: some View {
        FlowLayout(spacing: Spacing.sm) {
            ForEach(Array(data.series.enumerated()), id: \.offset) { index, series in
                HStack(spacing: Spacing.xs) {
                    Circle().fill(ChartPalette.color(for: colors[index])).frame(width: 7, height: 7)
                    Text(series.label)
                        .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityIdentifier("tile.legend")
    }

    private var points: [Point] {
        var out: [Point] = []
        let ratio = rightToLeft
        for (i, series) in data.series.enumerated() {
            let scale = rightSeries.contains(i) ? ratio : 1
            var run = 0
            var inRun = false
            for (b, value) in series.points.enumerated() where b < bucketKeys.count {
                guard let value else {
                    if inRun { run += 1; inRun = false }
                    continue
                }
                inRun = true
                out.append(Point(id: "\(series.key)|\(bucketKeys[b])", seriesKey: series.key, seriesIndex: i, bucketKey: bucketKeys[b], value: value * scale, run: run))
            }
        }
        return out
    }

    private var chart: some View {
        let points = points
        let domain = data.series.map(\.key)
        let range = colors.map { ChartPalette.color(for: $0) }
        let unit = data.series.first.map { $0.unit ?? "" } ?? ""
        let ratio = rightToLeft
        return Chart(points) { point in
            switch kind {
            case .line:
                LineMark(
                    x: .value("Bucket", point.bucketKey), y: .value(unit, point.value),
                    series: .value("Run", "\(point.seriesKey)#\(point.run)")
                )
                .foregroundStyle(by: .value("Series", point.seriesKey))
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .interpolationMethod(.monotone)
                if showsPoints {
                    PointMark(x: .value("Bucket", point.bucketKey), y: .value(unit, point.value))
                        .foregroundStyle(by: .value("Series", point.seriesKey))
                        .symbolSize(scrubKey == point.bucketKey ? 40 : 12)
                }
            case .area:
                AreaMark(
                    x: .value("Bucket", point.bucketKey), y: .value(unit, point.value),
                    series: .value("Run", "\(point.seriesKey)#\(point.run)"), stacking: .unstacked
                )
                .foregroundStyle(by: .value("Series", point.seriesKey))
                .opacity(0.18)
                .interpolationMethod(.monotone)
                LineMark(
                    x: .value("Bucket", point.bucketKey), y: .value(unit, point.value),
                    series: .value("Run", "\(point.seriesKey)#\(point.run)")
                )
                .foregroundStyle(by: .value("Series", point.seriesKey))
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .interpolationMethod(.monotone)
            case .bar:
                BarMark(x: .value("Bucket", point.bucketKey), y: .value(unit, point.value))
                    .foregroundStyle(by: .value("Series", point.seriesKey))
                    .position(by: .value("Series", point.seriesKey))
                    .opacity(scrubKey == nil || scrubKey == point.bucketKey ? 1 : 0.55)
            case .stackedBar:
                BarMark(x: .value("Bucket", point.bucketKey), y: .value(unit, point.value))
                    .foregroundStyle(by: .value("Series", point.seriesKey))
                    .opacity(scrubKey == nil || scrubKey == point.bucketKey ? 1 : 0.55)
            }
            if let scrubKey, kind == .line || kind == .area, point.bucketKey == scrubKey, point.id == points.first(where: { $0.bucketKey == scrubKey })?.id {
                RuleMark(x: .value("Bucket", scrubKey))
                    .foregroundStyle(ApexColor.textMuted)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
            }
        }
        .chartForegroundStyleScale(domain: domain, range: range)
        .chartLegend(.hidden)
        .chartXScale(domain: bucketKeys)
        .chartXAxis {
            AxisMarks(values: tickKeys) { value in
                AxisValueLabel {
                    if let key = value.as(String.self) {
                        Text(label(for: key))
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                    }
                }
            }
        }
        .chartYAxis {
            if isGrade {
                AxisMarks(position: .leading, values: [Double]()) { _ in }
            } else {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                    AxisValueLabel {
                        if let v = value.as(Double.self) {
                            Text(TileFormat.value(v))
                                .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                    }
                }
                if hasRightAxis {
                    // Round numbers on the right axis, placed where they fall on the left scale.
                    AxisMarks(position: .trailing, values: Self.niceTicks(upTo: axisMax(right: true)).map { $0 * ratio }) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text(TileFormat.value(v / ratio))
                                    .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                                    .foregroundStyle(ApexColor.textMuted)
                            }
                        }
                    }
                }
            }
        }
        // A tap pins the bucket under the finger; the same bucket again (or a
        // tap outside the plot) clears it. Never a drag: on a page of charts a
        // zero-distance drag swallows every vertical flick, and so does a
        // hold-then-drag — both were tried on the simulator (U13 asks for
        // values on tap, not hover; a pinned card is that).
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(.rect)
                    .onTapGesture { location in
                        guard let plot = proxy.plotFrame else { return }
                        let key: String? = proxy.value(atX: location.x - geometry[plot].origin.x)
                        withAnimation(.easeOut(duration: 0.1)) { scrubKey = (key == nil || key == scrubKey) ? nil : key }
                    }
            }
        }
        .animation(nil, value: scrubKey)
    }

    /// 1-2-5 steps up to `max`, at most five marks — what an axis would pick itself.
    static func niceTicks(upTo max: Double) -> [Double] {
        guard max > 0 else { return [0] }
        let rough = max / 4
        let magnitude = pow(10, floor(log10(rough)))
        let residual = rough / magnitude
        let step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude
        return stride(from: 0, through: max, by: step).map { $0 }
    }

    /// Every bucket up to eight; past that, evenly spaced ticks — a tick
    /// text you cannot read is not a tick (U26).
    private var tickKeys: [String] {
        let keys = bucketKeys
        guard keys.count > 8 else { return keys }
        let step = Int((Double(keys.count) / 6).rounded(.up))
        return stride(from: 0, to: keys.count, by: step).map { keys[$0] }
    }

    private func label(for key: String) -> String {
        data.buckets.first { $0.key == key }?.label ?? key
    }
}

/// The chart rotor's view of a tile: a categorical x-axis of buckets, a numeric
/// y-axis in the tile's unit, and one series descriptor per plotted series with
/// every non-gap point named. VoiceOver reads the values, plays the audio graph
/// and lets the user walk the series — none of which a `Chart` offers by itself.
///
/// Its own `nonisolated` type rather than a conformance on `TileChartView`:
/// ApexFeatures compiles with `defaultIsolation(MainActor.self)`, and an
/// isolated method cannot witness `AXChartDescriptorRepresentable`'s
/// requirements. `Kind` and `TileData` are both `Sendable`, so the copy costs
/// nothing.
public nonisolated struct TileChartDescriptor: AXChartDescriptorRepresentable {
    public let kind: TileChartView.Kind
    public let data: TileData

    public init(kind: TileChartView.Kind, data: TileData) {
        self.kind = kind
        self.data = data
    }

    /// The tile in one sentence, for `.accessibilityLabel` and the descriptor's
    /// own summary: "Line chart. Sep–Nov. Volume: 1,000 lb to 4,500 lb across
    /// 12 points."
    public var summary: String {
        var parts = ["\(kindLabel) chart"]
        if let range = data.rangeLabel, !range.isEmpty { parts.append(range) }
        if data.series.isEmpty {
            parts.append("No series plotted")
        } else {
            parts.append(contentsOf: data.series.map(Self.seriesSummary))
        }
        return parts.joined(separator: ". ") + "."
    }

    private var kindLabel: String {
        switch kind {
        case .line: "Line"
        case .area: "Area"
        case .bar: "Bar"
        case .stackedBar: "Stacked bar"
        }
    }

    /// Low and high by their *displayed* value, so a grade series reads
    /// "5.10a to 5.12c" rather than the ranks behind it.
    static func seriesSummary(_ series: TileData.Series) -> String {
        let plotted = series.points.enumerated().compactMap { index, value in value.map { (index, $0) } }
        guard let low = plotted.min(by: { $0.1 < $1.1 }), let high = plotted.max(by: { $0.1 < $1.1 }) else {
            return "\(series.label): no values"
        }
        if plotted.count == 1 {
            return "\(series.label): \(TileFormat.value(series, at: high.0)), one point"
        }
        return "\(series.label): \(TileFormat.value(series, at: low.0)) to \(TileFormat.value(series, at: high.0)) across \(plotted.count) points"
    }

    public func makeChartDescriptor() -> AXChartDescriptor {
        let categories = data.buckets.map { $0.label.isEmpty ? $0.key : $0.label }
        let xAxis = AXCategoricalDataAxisDescriptor(title: "Bucket", categoryOrder: categories)

        let values = data.series.flatMap { $0.points.compactMap { $0 } }
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let yAxis = AXNumericDataAxisDescriptor(
            title: data.series.first?.unit ?? "Value",
            // A flat series would be a zero-width range, which the rotor cannot
            // step through.
            range: low...(high > low ? high : low + 1),
            gridlinePositions: []
        ) { TileFormat.value($0) }

        // `isContinuous` is what tells VoiceOver whether the points are a line
        // to sweep or bars to step between.
        let continuous = kind == .line || kind == .area
        let series = data.series.map { series in
            AXDataSeriesDescriptor(
                name: series.label,
                isContinuous: continuous,
                dataPoints: series.points.enumerated().compactMap { index, value in
                    guard let value, index < categories.count else { return nil }
                    return AXDataPoint(
                        x: categories[index],
                        y: value,
                        additionalValues: [],
                        label: TileFormat.value(series, at: index)
                    )
                }
            )
        }

        return AXChartDescriptor(
            title: data.rangeLabel,
            summary: summary,
            xAxis: xAxis,
            yAxis: yAxis,
            additionalAxes: [],
            series: series
        )
    }

    public func updateChartDescriptor(_ descriptor: AXChartDescriptor) {}
}
