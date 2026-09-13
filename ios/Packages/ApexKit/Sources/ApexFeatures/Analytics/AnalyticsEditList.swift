import ApexCore
import ApexUI
import SwiftUI

/// Edit mode (D-011): the tiles as a reorderable list with an S / M / L
/// height per row. Its own `List` state — a `List` inside the dashboard's
/// `ScrollView` would not drag — committed by Done, dropped by Cancel.
struct AnalyticsEditList: View {
    @Bindable var model: AnalyticsModel

    var body: some View {
        List {
            Section {
                ForEach(model.editOrder, id: \.self) { id in
                    if let tile = model.tile(id: id) {
                        row(tile)
                            .listRowBackground(ApexColor.bgSurface)
                            .listRowSeparatorTint(ApexColor.borderSubtle)
                            .listRowInsets(EdgeInsets(top: Spacing.sm, leading: Spacing.md, bottom: Spacing.sm, trailing: Spacing.md))
                    }
                }
                .onMove { from, to in model.move(from: from, to: to) }
            } header: {
                Text("Drag to reorder · tap a size").apexEyebrow()
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(ApexColor.bgPrimary)
        .environment(\.editMode, .constant(.active))
        .accessibilityIdentifier("analytics.editlist")
    }

    private func row(_ tile: AnalyticsTile) -> some View {
        HStack(spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(tile.title)
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(1)
                Text(AnalyticsCatalog.chartTypes.first { $0.value == tile.chartType }?.label ?? "Invalid tile")
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            Spacer(minLength: Spacing.sm)
            ApexSegmented(
                selection: Binding(
                    get: { model.editHeights[tile.id] ?? TileHeight.nearest(h: tile.layout.h) },
                    set: { model.setHeight(tile.id, $0) }
                ),
                options: TileHeight.allCases.map { (value: $0, label: $0.label) }
            )
            .frame(width: 132)
            .accessibilityIdentifier("tile.height.\(tile.id)")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tile.editrow.\(tile.id)")
    }
}
