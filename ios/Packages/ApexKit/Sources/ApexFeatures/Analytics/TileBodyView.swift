import ApexCore
import ApexUI
import SwiftUI

/// The renderer switch (`TileRenderer.tsx`): charts, the stat row, the table.
///
/// ux-review §3.7: a line or area tile with fewer than two plotted buckets
/// drew a 250pt empty chart with a 4px arc at the top of it. One number is a
/// number, not a trend — it goes through the stat renderer instead, with the
/// count where the range label would be, so the tile says what it has.
public struct TileBodyView: View {
    let chartType: String
    let data: TileData

    public init(chartType: String, data: TileData) {
        self.chartType = chartType
        self.data = data
    }

    public var body: some View {
        switch chartType {
        case "kpi": KPIRowView(data: data)
        case "table": TileTableView(data: data)
        default:
            if Self.rendersAsStat(chartType: chartType, data: data) {
                KPIRowView(data: data, caption: Self.sparseCaption(data))
            } else {
                TileChartView(kind: TileChartView.Kind(rawValue: chartType) ?? .line, data: data)
            }
        }
    }

    /// Buckets where at least one series has a value. A gap is `nil`, not a
    /// zero, so a series of `[nil, 150, nil]` is one point however many
    /// buckets the range spans — which is the case the review caught.
    public static func plottedBuckets(_ data: TileData) -> Int {
        let width = max(data.buckets.count, data.series.map(\.points.count).max() ?? 0)
        return (0..<width).filter { index in
            data.series.contains { $0.points.indices.contains(index) && $0.points[index] != nil }
        }.count
    }

    /// Whether this body draws through the stat renderer rather than a chart.
    /// A bar with one bar is a bar; a line with one point is nothing at all,
    /// so only the two line-shaped types fall through.
    public static func rendersAsStat(chartType: String, data: TileData) -> Bool {
        guard chartType == "line" || chartType == "area" else { return false }
        return plottedBuckets(data) < 2
    }

    /// Where the range label would go: what the one point actually is.
    private static func sparseCaption(_ data: TileData) -> String? {
        plottedBuckets(data) == 1 ? "1 session" : data.rangeLabel
    }
}
