import ApexCore
import ApexUI
import SwiftUI

/// The read-only event sheet (`WorkoutModal.tsx` minus its inline editing,
/// which is W7). Renders from the model by id, never from a copy, so a
/// completion or a realtime edit shows while the sheet is up.
public struct EventSheet: View {
    let model: ScheduleModel
    let eventId: String
    let onClose: () -> Void

    public init(model: ScheduleModel, eventId: String, onClose: @escaping () -> Void) {
        self.model = model
        self.eventId = eventId
        self.onClose = onClose
    }

    public var body: some View {
        if let event = model.event(id: eventId) {
            EventSheetContent(model: model, event: event, onClose: onClose)
        } else {
            VStack(spacing: Spacing.md) {
                SheetHeader(title: "Workout", onClose: onClose)
                EmptyState(eyebrow: "Gone", message: "This workout is no longer on the schedule.", symbol: ApexIcon.calendar.systemName)
            }
            .background(ApexColor.bgSurface)
        }
    }
}

private struct EventSheetContent: View {
    let model: ScheduleModel
    let event: ScheduleEvent
    let onClose: () -> Void
    @State private var streams: ActivityStreamRecord?
    @State private var isToggling = false

    private var base: WorkoutEventBase { event.base }
    private var palette: WorkoutPalette { WorkoutTypeTokens.palette(for: event.type.rawValue) }
    private static let difficultyLabels = ["", "Easy", "Moderate", "Challenging", "Hard", "Maximal"]

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "", onClose: onClose)
                .frame(height: 0)
                .hidden()
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    header
                    metaStrip
                    if let streams { SyncMetricsView(record: streams) }
                    difficulty
                    actions
                    if let description = base.description, !description.isEmpty {
                        Text(description).apexBody()
                    }
                    sections
                    if let tags = base.tags, !tags.isEmpty {
                        FlowTags(tags: tags)
                    }
                }
                .padding(.horizontal, Spacing.screen)
                .padding(.top, Spacing.xl)
                .padding(.bottom, Spacing.xxl)
            }
        }
        .background(ApexColor.bgSurface)
        .overlay(alignment: .topTrailing) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .padding(.trailing, Spacing.xs)
        }
        .task(id: event.id) { streams = await model.streams(for: event) }
        .accessibilityIdentifier("schedule.event")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            RoundedRectangle(cornerRadius: 2).fill(palette.solid).frame(width: 4)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                WorkoutTypeBadge(rawType: event.type.rawValue)
                Text(event.title)
                    .apexTitle()
                    .accessibilityIdentifier("schedule.event.title")
                if let subtitle = base.subtitle, !subtitle.isEmpty {
                    Text(subtitle).apexBody()
                }
            }
            Spacer(minLength: 32)
        }
    }

    private var metaStrip: some View {
        FlowLayout(spacing: Spacing.md) {
            meta(.calendar, "\(MonthNames.weekdayLong[event.day.weekday - 1]), \(MonthNames.short[event.day.month - 1]) \(event.day.day)")
            if let range = TimeLabel.range(start: event.startTime, end: event.endTime) { meta(.clock, range) }
            if let minutes = event.estimatedDuration { meta(.clock, TimeLabel.duration(minutes: minutes)) }
            if let location = base.location, !location.isEmpty { meta(.mapPin, location) }
            if let distance = base.cardioTargets?.distance, !distance.isEmpty { meta(.route, distance) }
            if let gain = base.cardioTargets?.elevationGain, !gain.isEmpty { meta(.trendingUp, gain) }
            if let hr = base.cardioTargets?.avgHeartRate { meta(.heartPulse, "\(Int(hr)) bpm") }
            if let grade = base.climbingTargets?.maxGrade, !grade.isEmpty { meta(.mountain, "Max \(grade)") }
            if let pitches = base.climbingTargets?.totalPitches { meta(.layers, "\(pitches) pitch\(pitches == 1 ? "" : "es")") }
        }
    }

    private func meta(_ icon: ApexIcon, _ text: String) -> some View {
        HStack(spacing: Spacing.xs) {
            icon.image.font(.system(size: 12))
            Text(text).font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
        }
        .foregroundStyle(ApexColor.textSecondary)
    }

    @ViewBuilder
    private var difficulty: some View {
        if let level = base.difficulty, (1...5).contains(level) {
            HStack(spacing: Spacing.sm) {
                HStack(spacing: 4) {
                    ForEach(1...5, id: \.self) { i in
                        Circle()
                            .fill(i <= level ? palette.solid : ApexColor.bgElevated)
                            .overlay(Circle().strokeBorder(i <= level ? .clear : ApexColor.borderSubtle, lineWidth: 1))
                            .frame(width: 10, height: 10)
                    }
                }
                Text(Self.difficultyLabels[level])
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Difficulty \(Self.difficultyLabels[level])")
        }
    }

    private var actions: some View {
        VStack(spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                ApexButton("Start Workout", kind: .secondary) {}
                    .disabled(true)
                    .opacity(0.5)
                ApexButton(event.isCompleted ? "Completed" : "Mark as Complete", kind: event.isCompleted ? .secondary : .primary, isLoading: isToggling) {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    isToggling = true
                    Task {
                        await model.toggleCompletion(event)
                        isToggling = false
                    }
                }
                .accessibilityIdentifier("schedule.event.complete")
            }
            Text("The tracker arrives in the next build.")
                .font(.apex(.display, size: TypeScale.micro, relativeTo: .caption2))
                .foregroundStyle(ApexColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sections: some View {
        let outdoor = event.type == .outdoorClimbing
        let labels = outdoor ? ("Approach", "Pitches", "Descent") : ("Warm-Up", "Main Work", "Cool-Down")
        return VStack(alignment: .leading, spacing: Spacing.lg) {
            section(labels.0, base.warmup)
            section(labels.1, base.exercises)
            section(labels.2, base.cooldown)
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ exercises: [Exercise]?) -> some View {
        if let exercises, !exercises.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text(title).apexEyebrow()
                ForEach(Array(SupersetGrouping.groups(exercises).enumerated()), id: \.offset) { _, group in
                    HStack(alignment: .top, spacing: Spacing.sm) {
                        if let label = group.superset {
                            VStack(spacing: 2) {
                                Text(label)
                                    .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
                                    .foregroundStyle(ApexColor.bgPrimary)
                                    .frame(width: 18, height: 18)
                                    .background(palette.border, in: .circle)
                                RoundedRectangle(cornerRadius: 1).fill(palette.border.opacity(0.6)).frame(width: 2)
                            }
                            .accessibilityLabel("Superset \(label)")
                        }
                        VStack(alignment: .leading, spacing: Spacing.sm) {
                            ForEach(group.exercises, id: \.id) { exercise in
                                ExerciseRow(exercise: exercise, accent: palette.border)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Consecutive entries sharing a superset letter render together. Display
/// grouping only — the labels themselves are maintained server side.
enum SupersetGrouping {
    struct Group { let superset: String?; let exercises: [Exercise] }

    static func groups(_ exercises: [Exercise]) -> [Group] {
        var out: [Group] = []
        for exercise in exercises {
            if let label = exercise.superset, !label.isEmpty, let last = out.last, last.superset == label {
                out[out.count - 1] = Group(superset: label, exercises: last.exercises + [exercise])
            } else {
                out.append(Group(superset: exercise.superset.flatMap { $0.isEmpty ? nil : $0 }, exercises: [exercise]))
            }
        }
        // A lone label is meaningless (supersets.ts clears it); show it plain.
        return out.map { $0.exercises.count == 1 ? Group(superset: nil, exercises: $0.exercises) : $0 }
    }
}

/// `ExerciseCard.tsx`: name, the prescription line, notes, muscle tags.
struct ExerciseRow: View {
    let exercise: Exercise
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(exercise.name)
                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
            if let meta = metaLine {
                Text(meta)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(accent)
            }
            if let planned = exercise.plannedSets, planned.count > 1 {
                Text(planned.map { set in
                    [set.targetWeight, set.targetReps.map { "×\($0)" }, set.targetDuration].compactMap { $0 }.joined(separator: " ")
                }.joined(separator: " · "))
                .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                .foregroundStyle(ApexColor.textMuted)
            }
            if let notes = exercise.notes, !notes.isEmpty {
                Text(notes).font(.apex(.display, size: TypeScale.xs, relativeTo: .caption)).foregroundStyle(ApexColor.textSecondary)
            }
            if let groups = exercise.muscleGroups, !groups.isEmpty {
                Text(groups.joined(separator: " · "))
                    .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                    .foregroundStyle(ApexColor.textMuted)
            }
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
    }

    private var metaLine: String? {
        var parts: [String] = []
        if exercise.category == "climbing" {
            if let style = exercise.climbStyle { parts.append(style.replacingOccurrences(of: "-", with: "/").capitalized) }
            if let grade = exercise.grade { parts.append(grade) }
            if let ascent = exercise.ascentStyle { parts.append(ascent.capitalized) }
        } else {
            switch (exercise.sets, exercise.reps) {
            case let (sets?, reps?): parts.append("\(sets) × \(reps)")
            case let (sets?, nil): parts.append("\(sets) sets")
            case let (nil, reps?): parts.append(reps)
            default: break
            }
            if let duration = exercise.duration { parts.append(duration) }
            if let weight = exercise.weight { parts.append(weight) }
            if let rest = exercise.restPeriod { parts.append("Rest \(rest)") }
        }
        return parts.isEmpty ? nil : parts.joined(separator: "  ·  ")
    }
}

/// `SyncMetrics.tsx`: the provider badge, the measured numbers, the charts.
struct SyncMetricsView: View {
    let record: ActivityStreamRecord

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            FlowLayout(spacing: Spacing.md) {
                HStack(spacing: Spacing.xs) {
                    ApexIcon.watch.image.font(.system(size: 11))
                    Text("Synced from \(SyncMetricsFormatter.providerLabel(record.provider))")
                        .font(.apex(.display, size: TypeScale.micro, weight: .semibold, relativeTo: .caption2))
                }
                .foregroundStyle(ApexPalette.streamMark)
                .padding(.horizontal, Spacing.sm)
                .padding(.vertical, 3)
                .overlay(Capsule().strokeBorder(ApexPalette.streamMark.opacity(0.5), lineWidth: 1))
                .accessibilityIdentifier("schedule.event.synced")

                ForEach(Array(SyncMetricsFormatter.items(record.summary).enumerated()), id: \.offset) { _, item in
                    HStack(spacing: Spacing.xs) {
                        icon(for: item.kind).image.font(.system(size: 12))
                        Text(item.text).font(.apex(.mono, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    }
                    .foregroundStyle(ApexColor.textPrimary)
                }
            }
            if record.hrSamples.count > 1 || record.gpsSamples.count > 1 {
                StreamChartsView(record: record)
            }
        }
    }

    private func icon(for kind: SyncMetricItem.Kind) -> ApexIcon {
        switch kind {
        case .heartRate: .heartPulse
        case .distance: .route
        case .elevation: .trendingUp
        case .calories: .flame
        case .load: .watch
        }
    }
}

/// Tags as wrapping chips.
struct FlowTags: View {
    let tags: [String]

    var body: some View {
        FlowLayout(spacing: Spacing.xs) {
            ForEach(tags, id: \.self) { Chip($0) }
        }
    }
}

/// A minimal wrapping layout (the web's flex-wrap).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal: proposal, subviews: subviews)
        let width = proposal.width ?? rows.map(\.width).max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + CGFloat(max(rows.count - 1, 0)) * spacing
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(proposal: proposal, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> [Row] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [Row] = [Row()]
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            var row = rows[rows.count - 1]
            let needed = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            if needed > maxWidth, !row.indices.isEmpty {
                rows.append(Row(indices: [index], width: size.width, height: size.height))
            } else {
                row.indices.append(index)
                row.width = needed
                row.height = max(row.height, size.height)
                rows[rows.count - 1] = row
            }
        }
        return rows
    }
}
