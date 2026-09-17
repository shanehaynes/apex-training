import ApexCore
import ApexUI
import SwiftUI

/// One block (`BlockDetail.tsx`): the objective and intent, then the
/// server's progress — block to date, this week, the by-week table with its
/// attainment column visible on the phone (U12), the PRs set inside it.
/// Read from the model on every render so an edit shows the moment it lands;
/// a deleted block pops the screen.
public struct BlockDetailView: View {
    private let model: BlocksModel
    private let id: String
    @State private var sheet: BlocksSheet?
    @Environment(\.dismiss) private var dismiss

    public init(model: BlocksModel, id: String) {
        self.model = model
        self.id = id
    }

    public var body: some View {
        Group {
            if let block = model.block(id: id) {
                content(block)
            } else {
                EmptyState(eyebrow: "Blocks", message: "That block is no longer here.", symbol: ApexIcon.layers.systemName)
            }
        }
        .youScreen(model.block(id: id)?.name ?? "Block")
        .toolbar {
            if model.block(id: id) != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { sheet = .editor(model.block(id: id)) }
                        .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                        .accessibilityIdentifier("block.edit")
                }
            }
        }
        .sheet(item: $sheet, onDismiss: {
            model.flushNotice()
            if model.hasLoaded, model.block(id: id) == nil { dismiss() }
        }) { sheet in
            Group {
                if case .editor(let block) = sheet {
                    BlockEditorSheet(model: model, block: block) { self.sheet = nil }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .task(id: id) { await model.loadProgress(id: id) }
        .refreshable { await model.loadProgress(id: id) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("block.detail")
    }

    private func content(_ block: BlockSummary) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                header(block)
                if let progress = model.progress[block.id] {
                    toDate(progress)
                    if let week = progress.currentWeek, progress.weeks.indices.contains(week - 1) {
                        thisWeek(progress.weeks[week - 1], week: week)
                    }
                    byWeek(progress)
                    if !progress.prs.isEmpty { prs(progress.prs) }
                } else if model.progressFailed.contains(block.id) {
                    Text("Progress could not be loaded — pull to try again.").apexBody()
                } else {
                    ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity)
                }
            }
            .padding(Spacing.screen)
        }
    }

    private func header(_ block: BlockSummary) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(block.name)
                    .font(.apex(.display, size: TypeScale.xl, weight: .bold, relativeTo: .title2))
                    .tracking(-0.3)
                    .foregroundStyle(ApexColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: Spacing.sm)
                Text(block.currentWeek != nil ? BlocksModel.weekLabel(block) : BlocksModel.periodLabel(startDate: block.startDate, endDateExclusive: block.endDateExclusive))
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textSecondary)
                    .accessibilityIdentifier("block.detail.week")
            }
            if let objective = model.objective(for: block) {
                (Text("Objective: ") + Text(objective.name).fontWeight(.semibold)
                    + Text(objective.targetDate.map { " · \($0)" } ?? ""))
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .accessibilityIdentifier("block.detail.objective")
            }
            if !block.intent.isEmpty {
                Text(block.intent).apexBody().fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func section(_ title: String, sub: String? = nil, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                Text(title).apexEyebrow()
                if let sub {
                    Text(sub)
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                }
            }
            content()
        }
    }

    private func toDate(_ progress: BlockProgress) -> some View {
        section("Block to date", sub: "\(progress.weeksElapsed) of \(progress.weeksTotal) weeks complete") {
            if progress.weeksElapsed == 0 {
                Text("No completed weeks yet.").apexBody()
            } else {
                AttainmentBars(rows: progress.toDate.attainment)
            }
        }
        // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("block.detail.todate")
    }

    private func thisWeek(_ week: BlockProgress.Week, week index: Int) -> some View {
        section("This week", sub: "week \(index), in progress") {
            AttainmentBars(rows: week.attainment)
        }
        // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("block.detail.thisweek")
    }

    private func byWeek(_ progress: BlockProgress) -> some View {
        section("By week") {
            BlockWeeksTable(weeks: progress.weeks, currentWeek: progress.currentWeek)
        }
        // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("block.detail.byweek")
    }

    private func prs(_ records: [BlockRecord]) -> some View {
        section("PRs this block", sub: String(records.count)) {
            SettingsSection {
                ForEach(Array(records.enumerated()), id: \.offset) { index, record in
                    if index > 0 { SettingsDivider() }
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: Spacing.sm) {
                            Text(record.date)
                                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                .foregroundStyle(ApexColor.textMuted)
                            Text(record.exerciseName)
                                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                                .foregroundStyle(ApexColor.textPrimary)
                        }
                        Text(record.description)
                            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                            .foregroundStyle(ApexColor.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.md)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("block.detail.pr.\(index)")
                }
            }
        }
        // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("block.detail.prs")
    }
}

/// A bar per target (`BlockProgressBars.tsx`), or the empty line.
struct AttainmentBars: View {
    let rows: [TargetAttainment]
    var emptyLabel = "No targets set for this block."

    var body: some View {
        if rows.isEmpty {
            Text(emptyLabel).apexBody()
        } else {
            VStack(alignment: .leading, spacing: Spacing.md) {
                ForEach(rows) { row in
                    AttainmentBar(
                        label: row.label, valueText: AttainmentBar.valueText(actual: row.actual, target: row.targetForWindow, unit: row.unit),
                        pct: row.pct, isDerived: row.isDerived, note: AttainmentBar.unmatchedNote(row.unmatchedUnits)
                    )
                    .accessibilityIdentifier("block.bar.\(row.key)")
                }
            }
        }
    }
}

/// The by-week table (`.block-weeks`): week · starting · sessions · the
/// attainment column the web hides on a phone (U12) — here it takes the
/// remaining width and wraps.
struct BlockWeeksTable: View {
    let weeks: [BlockProgress.Week]
    let currentWeek: Int?

    private let weekColumn: CGFloat = 40
    private let dateColumn: CGFloat = 56
    private let sessionsColumn: CGFloat = 60

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                header("Week").frame(width: weekColumn, alignment: .leading)
                header("Starting").frame(width: dateColumn, alignment: .leading)
                header("Sessions").frame(width: sessionsColumn, alignment: .leading)
                header("Attainment").frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            ForEach(weeks, id: \.index) { week in
                Rectangle().fill(ApexColor.borderSubtle).frame(height: 1)
                let isCurrent = week.index == currentWeek
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    cell(String(week.index), emphasis: isCurrent).frame(width: weekColumn, alignment: .leading)
                    cell(DayKey(week.startDate).map(LibraryModel.shortDate) ?? week.startDate, emphasis: isCurrent).frame(width: dateColumn, alignment: .leading)
                    cell(String(week.sessionsCompleted), emphasis: isCurrent).frame(width: sessionsColumn, alignment: .leading)
                    Text(Self.attainmentText(week.attainment))
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(isCurrent ? ApexColor.textPrimary : ApexColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.sm)
                .background(isCurrent ? ApexColor.bgElevated : .clear)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("block.weeks.row.\(week.index)")
            }
        }
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .clipShape(.rect(cornerRadius: Radius.lg))
    }

    private func header(_ text: String) -> some View {
        Text(text)
            .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
            .foregroundStyle(ApexColor.textMuted)
            .textCase(.uppercase)
            .lineLimit(1)
    }

    private func cell(_ text: String, emphasis: Bool) -> some View {
        Text(text)
            .font(.apex(.mono, size: TypeScale.xs, weight: emphasis ? .medium : .regular, relativeTo: .caption))
            .foregroundStyle(emphasis ? ApexColor.textPrimary : ApexColor.textSecondary)
            .monospacedDigit()
    }

    /// "cardio 92% · strength 100%" — the web's cell, lowercased labels.
    static func attainmentText(_ rows: [TargetAttainment]) -> String {
        guard !rows.isEmpty else { return "—" }
        return rows.map { "\($0.label.lowercased()) \(AttainmentBar.pctText($0.pct))" }.joined(separator: " · ")
    }
}
