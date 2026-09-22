import ApexCore
import ApexUI
import SwiftUI

/// `TileCard.tsx`: the title, the kebab (Edit · Duplicate · Delete, the last
/// a second confirming tap), the body at the tile's height, and the
/// excluded-entries footnote.
public struct TileCardView: View {
    let tile: AnalyticsTile
    let result: TileResult?
    let isComputing: Bool
    let onEdit: () -> Void
    let onDuplicate: () -> Void
    let onDelete: () -> Void

    @State private var confirmDelete = false

    public init(tile: AnalyticsTile, result: TileResult?, isComputing: Bool, onEdit: @escaping () -> Void, onDuplicate: @escaping () -> Void, onDelete: @escaping () -> Void) {
        self.tile = tile
        self.result = result
        self.isComputing = isComputing
        self.onEdit = onEdit
        self.onDuplicate = onDuplicate
        self.onDelete = onDelete
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                Text(tile.title)
                    .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(1)
                    .accessibilityIdentifier("tile.title.\(tile.id)")
                Spacer(minLength: 0)
                Menu {
                    Button { onEdit() } label: { Label("Edit", systemImage: ApexIcon.edit.systemName) }
                    Button { onDuplicate() } label: { Label("Duplicate", systemImage: ApexIcon.duplicate.systemName) }
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: ApexIcon.trash.systemName) }
                } label: {
                    ApexIcon.kebab.image
                        .font(.system(size: 16))
                        .foregroundStyle(ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Tile options: \(tile.title)")
                .accessibilityIdentifier("tile.menu.\(tile.id)")
            }
            // A stat row sizes to its numbers; every chart takes the tile's height.
            // A line with one point draws as a stat row, so it sizes to its numbers too.
            body(height: sizesToContent ? nil : TileHeight.nearest(h: tile.layout.h).points)
            if case .ok(let data) = result, let note = TileFormat.excluded(count: data.excludedCount) {
                Text(note)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption2))
                    .foregroundStyle(ApexColor.textMuted)
                    .accessibilityIdentifier("tile.excluded.\(tile.id)")
            }
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .confirmationDialog("Delete “\(tile.title)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Confirm delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tile.card.\(tile.id)")
    }

    /// True when the body is a stat row rather than a chart — the saved type,
    /// or a line the data is too sparse to draw (ux-review §3.7). Reserving
    /// 250pt for it is the empty tile the review is about.
    private var sizesToContent: Bool {
        if tile.chartType == "kpi" { return true }
        guard case .ok(let data) = result else { return false }
        return TileBodyView.rendersAsStat(chartType: tile.chartType ?? "line", data: data)
    }

    @ViewBuilder
    private func body(height: CGFloat?) -> some View {
        Group {
            if tile.draft == nil {
                TileProblemView(text: "This tile's saved configuration is no longer valid. Edit it to rebuild.")
            } else if let result {
                switch result {
                case .problem(let problem):
                    TileProblemView(text: problem)
                case .ok(let data):
                    TileBodyView(chartType: tile.chartType ?? "line", data: data)
                }
            } else if isComputing {
                ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TileProblemView(text: "Not computed yet — pull to refresh.")
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .frame(minHeight: 96)
        .accessibilityIdentifier("tile.body.\(tile.id)")
    }
}
