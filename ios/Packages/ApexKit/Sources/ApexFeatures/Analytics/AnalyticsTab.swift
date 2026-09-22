import ApexCore
import ApexUI
import SwiftUI

/// The Analytics tab (W9): the dashboard as a vertical list of tiles
/// (`AnalyticsView.tsx` on a phone), an edit mode that reorders and sizes
/// them (D-011), and the "+" that opens the tile builder.
public struct AnalyticsTab: View {
    @Bindable private var model: AnalyticsModel
    private let coachServices: CoachServices?

    public init(model: AnalyticsModel, coachServices: CoachServices? = nil) {
        self.model = model
        self.coachServices = coachServices
    }

    public var body: some View {
        NavigationStack {
            content
                .background(ApexColor.bgPrimary)
                .navigationTitle("Analytics")
                // Inline: the root swaps between a ScrollView and a List (edit
                // mode), and a large title does not survive that swap.
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        if model.isEditing {
                            Button("Cancel") { model.cancelEdit() }
                                .accessibilityIdentifier("analytics.edit.cancel")
                            Button("Done") { Task { await model.commitEdit() } }
                                .fontWeight(.semibold)
                                .accessibilityIdentifier("analytics.edit.done")
                        } else {
                            if !model.tiles.isEmpty {
                                Button("Edit") { model.beginEdit() }
                                    .accessibilityIdentifier("analytics.edit")
                            }
                            Button {
                                model.sheet = .builder(tile: nil)
                            } label: {
                                ApexIcon.plus.image
                                    .font(.system(size: 17, weight: .medium))
                                    .frame(width: 44, height: 44)
                                    .contentShape(.rect)
                            }
                            .accessibilityLabel("New tile")
                            .accessibilityIdentifier("analytics.add")
                        }
                    }
                }
                .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        }
        .sheet(item: $model.sheet) { item in
            switch item {
            case .builder(let tile):
                TileBuilderSheet(model: model, tile: tile, coachServices: coachServices, onClose: { model.sheet = nil })
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ApexColor.bgSurface)
            }
        }
        .task { await model.start() }
    }

    @ViewBuilder
    private var content: some View {
        if model.tiles.isEmpty, let error = model.loadError {
            VStack(spacing: Spacing.md) {
                Text(error).apexBody().multilineTextAlignment(.center)
                ApexButton("Retry", kind: .secondary) { Task { await model.refresh(reason: .retry) } }
                    .frame(maxWidth: 200)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(Spacing.screen)
            .accessibilityIdentifier("analytics.error")
        } else if model.tiles.isEmpty, model.hasLoaded {
            EmptyState(
                eyebrow: "Analytics",
                message: "No tiles yet — build your first chart with “New tile”.",
                symbol: ApexIcon.trendingUp.systemName
            )
            .accessibilityIdentifier("analytics.empty")
        } else if model.tiles.isEmpty {
            ProgressView()
                .tint(ApexColor.textMuted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.isEditing {
            AnalyticsEditList(model: model)
        } else {
            dashboard
        }
    }

    private var dashboard: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.md) {
                if let label = model.freshnessLabel {
                    FreshnessBanner(label)
                        .padding(.horizontal, -Spacing.screen)
                }
                ForEach(model.tiles) { tile in
                    TileCardView(
                        tile: tile,
                        result: model.result(for: tile),
                        isComputing: model.isComputing,
                        onEdit: { model.sheet = .builder(tile: tile) },
                        onDuplicate: { Task { await model.duplicate(tile) } },
                        onDelete: { Task { await model.delete(tile) } }
                    )
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.top, Spacing.md)
            .padding(.bottom, Spacing.xxl)
        }
        .accessibilityIdentifier("analytics.dashboard")
        .refreshable { await model.refresh(reason: .pullToRefresh) }
        // The identifier is applied above this on purpose: a modifier nearer
        // the leaf wins, so the count keeps its own name rather than the
        // dashboard's.
        .overlay(alignment: .topLeading) { countElement }
    }

    /// ux-review §3.7: "6 TILES" was a count styled as a heading, and it is
    /// gone from the screen — the tiles are the count. The number itself is
    /// how a save, a duplicate and a delete are known to have landed (the
    /// smoke waits on it; the card it is waiting for is at the bottom of a
    /// lazy stack and does not exist until scrolled to), so it stays as a
    /// static-text accessibility element with no pixels: an overlay, so it
    /// costs the layout nothing either.
    private var countElement: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityAddTraits(.isStaticText)
            .accessibilityLabel(TileFormat.tileCount(model.tiles.count))
            .accessibilityIdentifier("analytics.count")
    }
}
