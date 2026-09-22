import ApexCore
import ApexUI
import SwiftUI

/// The stat tile: one value per series, wrapping on a narrow phone (U26).
///
/// ux-review §3.7: a one-series stat tile said its name three times — the card
/// title, an eyebrow under it, then the number. The card title is the label,
/// so the eyebrow is drawn only where it distinguishes something: two series
/// or more, where it carries the series' colour dot as well.
public struct KPIRowView: View {
    let data: TileData
    /// Replaces `data.rangeLabel` under the value. `TileBodyView` passes the
    /// point count when a line too sparse to draw comes through here.
    let caption: String?

    public init(data: TileData, caption: String? = nil) {
        self.data = data
        self.caption = caption
    }

    private var showsLabels: Bool { data.series.count > 1 }

    public var body: some View {
        let colors = SeriesColors.assign(keys: data.series.map(\.key))
        FlowLayout(spacing: Spacing.lg) {
            ForEach(Array(data.series.enumerated()), id: \.offset) { index, series in
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    if showsLabels {
                        HStack(spacing: Spacing.xs) {
                            Circle().fill(ChartPalette.color(for: colors[index])).frame(width: 7, height: 7)
                            Text(series.label).apexEyebrow().lineLimit(1)
                        }
                    }
                    let at = Self.valueIndex(series)
                    HStack(alignment: .lastTextBaseline, spacing: Spacing.xs) {
                        Text(series.gradeLabel(at: at) ?? TileFormat.value(series.points.indices.contains(at) ? series.points[at] : nil))
                            .apexNumeric()
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        if series.gradeLabel(at: at) == nil, let unit = series.unit, !unit.isEmpty {
                            Text(unit)
                                .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                    }
                    if let below = caption ?? data.rangeLabel, !below.isEmpty {
                        Text(below)
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                            .lineLimit(1)
                    }
                }
                // The combined label is the value and its caption. With one
                // series the name is the card's title, one element above —
                // the same redundancy this change removes from the screen.
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("tile.kpi.\(series.key)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// A stat tile has one bucket and reads index 0. A sparse line arriving
    /// here has its one value somewhere in a range of gaps — the number the
    /// tile is about is that one, not the leading `nil`.
    private static func valueIndex(_ series: TileData.Series) -> Int {
        series.points.firstIndex { $0 != nil } ?? 0
    }
}

/// The table tile: buckets down, series across, a sticky header (U26).
/// Grade text beats the number where a series carries it.
public struct TileTableView: View {
    let data: TileData

    public init(data: TileData) { self.data = data }

    private let firstColumn: CGFloat = 96
    private let column: CGFloat = 84

    public var body: some View {
        // Both axes scroll for a wide table; the content is given the card's
        // size as a minimum so a short one sits top-left instead of centred.
        GeometryReader { geometry in
            ScrollView([.vertical, .horizontal]) {
                table
                    .frame(minWidth: geometry.size.width, minHeight: geometry.size.height, alignment: .topLeading)
            }
        }
        .accessibilityIdentifier("tile.table")
    }

    private var table: some View {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            Section {
                ForEach(Array(data.buckets.enumerated()), id: \.offset) { index, bucket in
                    row(index: index, label: bucket.label.isEmpty ? (data.rangeLabel ?? "") : bucket.label)
                }
            } header: {
                HStack(spacing: 0) {
                    cell("", width: firstColumn, header: true)
                    ForEach(data.series, id: \.key) { series in
                        cell(header(for: series), width: column, header: true)
                    }
                }
                .background(ApexColor.bgElevated)
                .overlay(alignment: .bottom) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
            }
        }
    }

    private func header(for series: TileData.Series) -> String {
        let unit = series.unit ?? ""
        return unit.isEmpty ? series.label : "\(series.label) \(unit)"
    }

    private func row(index: Int, label: String) -> some View {
        HStack(spacing: 0) {
            cell(label, width: firstColumn, header: false)
            ForEach(data.series, id: \.key) { series in
                cell(series.gradeLabel(at: index) ?? TileFormat.value(series.points.indices.contains(index) ? series.points[index] : nil), width: column, header: false)
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(ApexColor.borderSubtle.opacity(0.5)).frame(height: 1) }
    }

    private func cell(_ text: String, width: CGFloat, header: Bool) -> some View {
        Text(text)
            .font(.apex(.mono, size: TypeScale.xs, weight: header ? .medium : .regular, relativeTo: .caption))
            .foregroundStyle(header ? ApexColor.textMuted : ApexColor.textPrimary)
            .monospacedDigit()
            .lineLimit(1)
            .frame(width: width, alignment: .leading)
            .padding(.vertical, Spacing.sm)
            .padding(.horizontal, Spacing.xs)
    }
}

/// The error tile: the server's problem, or the invalid-row copy.
public struct TileProblemView: View {
    let text: String

    public init(text: String) { self.text = text }

    public var body: some View {
        Text(text)
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textMuted)
            .multilineTextAlignment(.center)
            .padding(Spacing.md)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("tile.problem")
    }
}

/// The scrub readout (`TileTooltip`): the bucket, then one line per series
/// with its dot — on a card, not a hover (U13).
struct ScrubCard: View {
    let title: String
    let rows: [(label: String, value: String, color: Color)]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(title)
                .font(.apex(.mono, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                .foregroundStyle(ApexColor.textSecondary)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: Spacing.xs) {
                    Circle().fill(row.color).frame(width: 7, height: 7)
                    Text(row.label)
                        .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textSecondary)
                        .lineLimit(1)
                    Text(row.value)
                        .font(.apex(.mono, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textPrimary)
                        .monospacedDigit()
                }
            }
        }
        .padding(Spacing.sm)
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .accessibilityIdentifier("tile.scrub")
    }
}
