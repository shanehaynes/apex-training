import ApexCore
import ApexUI
import SwiftUI

/// The block sheets the list and the detail present.
enum BlocksSheet: Identifiable {
    case editor(BlockSummary?)
    case cycle

    var id: String {
        switch self {
        case .editor(let block): "editor:\(block?.id ?? "new")"
        case .cycle: "cycle"
        }
    }
}

/// Training blocks (`BlocksView.tsx`): every block with its period, phase
/// and objective, the week it is in, and the objectives beneath; "+" offers
/// a block or a whole cycle.
public struct BlocksView: View {
    private let model: BlocksModel
    @State private var sheet: BlocksSheet?

    public init(model: BlocksModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                if let error = model.loadError, !model.hasLoaded {
                    loadFailed(error)
                } else if model.isLoading, !model.hasLoaded {
                    ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity)
                } else if model.blocks.isEmpty {
                    Text("No training blocks yet. A block is a dated stretch of training with weekly targets — it's what lets the coach say “92% of planned aerobic volume” instead of “7 hours.” Start with a cycle: three weeks of work, one easier week, repeated.")
                        .apexBody()
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("blocks.empty")
                } else {
                    rows
                }
                if !model.objectives.isEmpty { objectivesSection }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Training blocks")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { sheet = .editor(nil) } label: { Label("New block", systemImage: ApexIcon.plus.systemName) }
                        .accessibilityIdentifier("blocks.add.block")
                    Button { sheet = .cycle } label: { Label("New cycle", systemImage: ApexIcon.recur.systemName) }
                        .accessibilityIdentifier("blocks.add.cycle")
                } label: {
                    ApexIcon.plus.image
                }
                .accessibilityLabel("Add")
                .accessibilityIdentifier("blocks.add")
            }
        }
        .sheet(item: $sheet, onDismiss: { model.flushNotice() }) { sheet in
            Group {
                switch sheet {
                case .editor(let block): BlockEditorSheet(model: model, block: block) { self.sheet = nil }
                case .cycle: CycleEditorSheet(model: model) { self.sheet = nil }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .task { await model.start() }
        .refreshable { await model.refresh() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("blocks.root")
    }

    private func loadFailed(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(message).apexBody().fixedSize(horizontal: false, vertical: true)
            ApexButton("Try again", kind: .secondary) { Task { await model.refresh() } }
        }
    }

    private var rows: some View {
        SettingsSection {
            ForEach(Array(model.blocks.enumerated()), id: \.element.id) { index, block in
                if index > 0 { SettingsDivider() }
                NavigationLink(value: YouRoute.block(id: block.id)) {
                    BlockRow(block: block, objective: model.objective(for: block))
                }
                .buttonStyle(SettingsRowButtonStyle())
                .accessibilityIdentifier("block.row.\(block.id)")
            }
        }
    }

    private var objectivesSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Label("Objectives", systemImage: ApexIcon.flag.systemName).apexEyebrow()
            SettingsSection {
                ForEach(Array(model.objectives.enumerated()), id: \.element.id) { index, objective in
                    if index > 0 { SettingsDivider() }
                    HStack(spacing: Spacing.sm) {
                        Text(objective.name)
                            .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                            .foregroundStyle(ApexColor.textPrimary)
                            .lineLimit(2)
                        Spacer(minLength: Spacing.sm)
                        if let date = objective.targetDate {
                            Text(date)
                                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                        if let discipline = objective.discipline { Chip(discipline) }
                    }
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.md)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("blocks.objective.\(objective.id)")
                }
            }
        }
        // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("blocks.objectives")
    }
}

/// One block row: name; period · phase · objective; the week or the length.
struct BlockRow: View {
    let block: BlockSummary
    let objective: Objective?

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.md) {
            if block.currentWeek != nil {
                RoundedRectangle(cornerRadius: 1.5).fill(ApexColor.accent).frame(width: 3)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(block.name)
                    .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(1)
                Text(meta)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: Spacing.sm)
            Text(BlocksModel.weekLabel(block))
                .font(.apex(.mono, size: TypeScale.xs, weight: block.currentWeek != nil ? .medium : .regular, relativeTo: .caption))
                .foregroundStyle(block.currentWeek != nil ? ApexColor.textPrimary : ApexColor.textSecondary)
                .lineLimit(1)
            ApexIcon.chevronRight.image.font(.system(size: 13, weight: .medium)).foregroundStyle(ApexColor.textMuted)
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var meta: String {
        var parts = [BlocksModel.periodLabel(startDate: block.startDate, endDateExclusive: block.endDateExclusive)]
        if let phase = block.phase { parts.append(phase) }
        if let objective { parts.append(objective.name) }
        return parts.joined(separator: " · ")
    }
}
