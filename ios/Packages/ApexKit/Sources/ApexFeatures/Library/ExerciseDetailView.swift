import ApexCore
import ApexUI
import SwiftUI

/// One exercise (`ExerciseDetail.tsx`): tags, aliases, notes, the PR and
/// session cards, the trend, recent sessions — and Edit, which opens the
/// editor sheet. The definition is read from the model on every render so a
/// save in the sheet shows here the moment it lands.
public struct ExerciseDetailView: View {
    private let model: LibraryModel
    private let id: String
    @State private var history: LibraryModel.HistoryOutcome?
    @State private var editing = false

    /// `history` preloads the section — previews and snapshots render the
    /// loaded state without a task; the screen normally fetches it.
    public init(model: LibraryModel, id: String, history: LibraryModel.HistoryOutcome? = nil) {
        self.model = model
        self.id = id
        _history = State(initialValue: history)
    }

    public var body: some View {
        Group {
            if let definition = model.definition(id: id) {
                content(definition)
            } else {
                EmptyState(eyebrow: "Library", message: "That exercise is no longer in your library.", symbol: ApexIcon.dumbbell.systemName)
            }
        }
        .youScreen(model.definition(id: id)?.canonicalName ?? "Exercise")
        .toolbar {
            if model.definition(id: id) != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { editing = true }
                        .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                        .accessibilityIdentifier("library.edit")
                }
            }
        }
        .sheet(isPresented: $editing, onDismiss: { model.flushNotice() }) {
            if let definition = model.definition(id: id) {
                DefinitionEditorSheet(model: model, definition: definition) { editing = false }
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ApexColor.bgSurface)
            }
        }
        .task(id: model.definition(id: id)?.canonicalName) {
            guard let definition = model.definition(id: id) else { return }
            if history == nil || model.needsHistoryReload(for: definition) {
                history = await model.history(for: definition)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library.detail")
    }

    private func content(_ definition: ExerciseDefinition) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                header(definition)
                if let aliases = definition.aliases, !aliases.isEmpty {
                    Text("Also known as: \(aliases.joined(separator: ", "))")
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("library.detail.aliases")
                }
                if let notes = definition.techniqueNotes, !notes.isEmpty {
                    Text(notes).apexBody().fixedSize(horizontal: false, vertical: true)
                }
                historySection
            }
            .padding(Spacing.screen)
        }
    }

    private func header(_ definition: ExerciseDefinition) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                Text(definition.canonicalName)
                    .font(.apex(.display, size: TypeScale.xl, weight: .bold, relativeTo: .title2))
                    .tracking(-0.3)
                    .foregroundStyle(ApexColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("library.detail.title")
                if definition.archivedAt != nil {
                    Text("archived")
                        .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
                        .foregroundStyle(ApexColor.textMuted)
                        .padding(.horizontal, Spacing.sm).padding(.vertical, 3)
                        .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                        .accessibilityIdentifier("library.detail.archived")
                }
            }
            FlowLayout(spacing: Spacing.xs) {
                if let category = definition.category { Chip(category) }
                if definition.isUnilateral == true { Chip("per side") }
                ForEach(definition.muscleGroups ?? [], id: \.self) { Chip($0) }
                ForEach(definition.equipment ?? [], id: \.self) { Chip($0, tint: ApexColor.borderSubtle) }
                if let count = model.referenceCount(definition) {
                    Chip(LibraryModel.referencesText(count))
                }
            }
        }
    }

    @ViewBuilder
    private var historySection: some View {
        switch history {
        case nil:
            Text("Loading history…").apexBody()
        case .none?:
            Text("No logged history yet.").apexBody().accessibilityIdentifier("library.detail.nohistory")
        case .failed(let message)?:
            Text(message).apexBody()
        case .history(let stats)?:
            statCards(stats)
            if stats.trend.count >= 2 { trend(stats) }
            sessions(stats)
        }
    }

    private func statCards(_ stats: ExerciseHistoryResult) -> some View {
        HStack(spacing: Spacing.md) {
            if let best = stats.allTimeBest {
                StatCard(label: "Best \(stats.statUnit)", value: best.display, sub: DayKey(best.date).map(LibraryModel.shortDate) ?? best.date, symbol: ApexIcon.trophy.systemName)
                    .accessibilityIdentifier("library.detail.best")
            }
            StatCard(
                label: "Sessions", value: String(stats.totalSessions),
                sub: stats.recentSessions.first.flatMap { DayKey($0.date) }.map { "last \(LibraryModel.shortDate($0))" } ?? "",
                symbol: nil
            )
            // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("library.detail.sessions")
        }
    }

    /// The web's recharts line, as the house tile chart: tap pins a value
    /// (never a drag, on a scrolling page — D-029).
    private func trend(_ stats: ExerciseHistoryResult) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("\(stats.statUnit) over time").apexEyebrow()
            TileChartView(kind: .line, data: TileData(
                buckets: stats.trend.map { .init(key: $0.date, label: DayKey($0.date).map(LibraryModel.shortDate) ?? $0.date) },
                series: [.init(key: "trend", label: stats.statUnit, unit: stats.statUnit, points: stats.trend.map { $0.value })]
            ))
            .frame(height: 180)
        }
        .accessibilityIdentifier("library.detail.trend")
    }

    private func sessions(_ stats: ExerciseHistoryResult) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Recent sessions").apexEyebrow()
            SettingsSection {
                ForEach(Array(stats.recentSessions.enumerated()), id: \.element.date) { index, session in
                    if index > 0 { SettingsDivider() }
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
                        Text(DayKey(session.date).map(LibraryModel.sessionDate) ?? session.date)
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                            .frame(width: 118, alignment: .leading)
                        Text(session.sets.joined(separator: "  ·  "))
                            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                            .foregroundStyle(ApexColor.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.md)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("library.detail.session.\(index)")
                }
            }
        }
    }
}

/// The web's `.library-stat-card`: a label, a big value, one muted line.
struct StatCard: View {
    let label: String
    let value: String
    let sub: String
    let symbol: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                if let symbol { Image(systemName: symbol).font(.system(size: 11)) }
                Text(label)
            }
            .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
            .foregroundStyle(ApexColor.textMuted)
            .textCase(.uppercase)
            .lineLimit(1)
            Text(value)
                .font(.apex(.display, size: TypeScale.xl, weight: .bold, relativeTo: .title2))
                .foregroundStyle(ApexColor.textPrimary)
                .monospacedDigit()
            Text(sub)
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textSecondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}
