import ApexCore
import ApexUI
import Charts
import SwiftUI

/// `StreamCharts.tsx` in Swift Charts: heart rate, the GPS route as an
/// outline (no tile server, coordinates never leave the app), elevation as an
/// area. One mark colour; min/max gridlines only; drag to scrub (U14).
struct StreamChartsView: View {
    let record: ActivityStreamRecord

    var body: some View {
        let hr = StreamDownsample.stride(record.hrSamples, maxCount: 600)
        let gps = StreamDownsample.stride(record.gpsSamples, maxCount: 600)
        VStack(alignment: .leading, spacing: Spacing.md) {
            if hr.count > 1 {
                TimeChart(title: "Heart rate", unit: "bpm", points: hr.map { .init(seconds: $0.seconds, value: $0.bpm) }, area: false)
            }
            if gps.count > 1 {
                RouteOutline(samples: gps)
                let elevation = gps.compactMap { s in s.elevationMeters.map { TimeChart.Point(seconds: s.seconds, value: $0 * 3.28084) } }
                if elevation.count > 1 {
                    TimeChart(title: "Elevation", unit: "ft", points: elevation, area: true)
                }
            }
        }
    }
}

struct TimeChart: View {
    struct Point: Identifiable { var id: Double { seconds }; let seconds: Double; let value: Double }

    let title: String
    let unit: String
    let points: [Point]
    let area: Bool
    @State private var scrub: Point?

    private var minValue: Double { points.map(\.value).min() ?? 0 }
    private var maxValue: Double { points.map(\.value).max() ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(title).apexEyebrow()
                Spacer()
                Text(readout)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(scrub == nil ? ApexColor.textMuted : ApexColor.textPrimary)
                    .monospacedDigit()
            }
            Chart {
                ForEach(points) { point in
                    if area {
                        AreaMark(x: .value("Time", point.seconds), y: .value(unit, point.value))
                            .foregroundStyle(ApexPalette.streamMark.opacity(0.18))
                            .interpolationMethod(.monotone)
                    }
                    LineMark(x: .value("Time", point.seconds), y: .value(unit, point.value))
                        .foregroundStyle(ApexPalette.streamMark)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                        .interpolationMethod(.monotone)
                }
                if let scrub {
                    RuleMark(x: .value("Time", scrub.seconds))
                        .foregroundStyle(ApexColor.textMuted)
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    PointMark(x: .value("Time", scrub.seconds), y: .value(unit, scrub.value))
                        .foregroundStyle(ApexPalette.streamMark)
                        .symbolSize(36)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis {
                AxisMarks(position: .trailing, values: [minValue, maxValue]) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [2, 3])).foregroundStyle(ApexColor.borderSubtle)
                    AxisValueLabel {
                        if let v = value.as(Double.self) {
                            Text(String(Int(v.rounded())))
                                .font(.apex(.mono, size: 10, relativeTo: .caption2))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                    }
                }
            }
            .chartYScale(domain: minValue...(maxValue == minValue ? maxValue + 1 : maxValue))
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(.rect)
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { drag in
                                    guard let plot = proxy.plotFrame else { return }
                                    let x = drag.location.x - geometry[plot].origin.x
                                    guard let seconds: Double = proxy.value(atX: x) else { return }
                                    scrub = points.min { abs($0.seconds - seconds) < abs($1.seconds - seconds) }
                                }
                                .onEnded { _ in scrub = nil }
                        )
                }
            }
            .frame(height: 96)
            .accessibilityLabel("\(title): \(Int(minValue))–\(Int(maxValue)) \(unit) over \(TimeLabel.elapsed(seconds: points.last?.seconds ?? 0))")
        }
    }

    private var readout: String {
        if let scrub { return "\(TimeLabel.elapsed(seconds: scrub.seconds)) · \(Int(scrub.value.rounded())) \(unit)" }
        return "\(Int(minValue.rounded()))–\(Int(maxValue.rounded())) \(unit)"
    }
}

/// Equirectangular outline of the route, fitted to a square, start dot marked.
struct RouteOutline: View {
    let samples: [ActivityStreamRecord.GPSSample]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Route").apexEyebrow()
            Canvas { context, size in
                guard samples.count > 1 else { return }
                let latMid = (samples.map(\.latitude).min()! + samples.map(\.latitude).max()!) / 2
                let kx = cos(latMid * .pi / 180)
                let xs = samples.map { $0.longitude * kx }, ys = samples.map(\.latitude)
                let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
                let span = max(maxX - minX, maxY - minY, 1e-9)
                let inset: CGFloat = 6
                let scale = (min(size.width, size.height) - inset * 2) / span
                let offsetX = (size.width - (maxX - minX) * scale) / 2
                let offsetY = (size.height - (maxY - minY) * scale) / 2
                func point(_ i: Int) -> CGPoint {
                    CGPoint(x: offsetX + (xs[i] - minX) * scale, y: size.height - offsetY - (ys[i] - minY) * scale)
                }
                var path = Path()
                path.move(to: point(0))
                for i in 1..<samples.count { path.addLine(to: point(i)) }
                context.stroke(path, with: .color(ApexPalette.streamMark), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                let start = point(0)
                context.fill(Path(ellipseIn: CGRect(x: start.x - 3, y: start.y - 3, width: 6, height: 6)), with: .color(ApexColor.textPrimary))
            }
            .frame(width: 108, height: 108)
            .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
            .accessibilityLabel("Route outline")
        }
    }
}
