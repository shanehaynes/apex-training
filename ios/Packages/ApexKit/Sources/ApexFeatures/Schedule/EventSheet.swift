import ApexCore
import ApexUI
import SwiftUI

/// The event sheet (`WorkoutModal.tsx`): the read view from W2 plus its edit
/// paths (W7) — inline title, the day and times through native pickers,
/// difficulty, Edit exercises, Edit workout, Delete (this day / the series).
/// Renders from the model by id, never from a copy, so a completion or a
/// realtime edit shows while the sheet is up.
public struct EventSheet: View {
    let model: ScheduleModel
    let eventId: String
    /// Start Workout (W4). Nil hides the button — the tracker needs a signed-in
    /// user's write queue behind it.
    let onStart: ((ScheduleEvent) -> Void)?
    /// "Edit workout" → the builder; "Edit exercises" → the sections editor.
    /// The tab presents both after this sheet dismisses.
    let onEditWorkout: ((ScheduleEvent) -> Void)?
    let onEditExercises: ((ScheduleEvent) -> Void)?
    let onClose: () -> Void
    let preview: PreviewState

    /// Which edit panel is open when the sheet appears — for previews and
    /// snapshots only; the app always starts closed.
    public struct PreviewState: Sendable {
        public var editingSchedule = false
        public var confirmingDelete = false
        public init(editingSchedule: Bool = false, confirmingDelete: Bool = false) {
            self.editingSchedule = editingSchedule
            self.confirmingDelete = confirmingDelete
        }
    }

    public init(
        model: ScheduleModel, eventId: String, onStart: ((ScheduleEvent) -> Void)? = nil,
        onEditWorkout: ((ScheduleEvent) -> Void)? = nil, onEditExercises: ((ScheduleEvent) -> Void)? = nil,
        onClose: @escaping () -> Void, preview: PreviewState = PreviewState()
    ) {
        self.model = model
        self.eventId = eventId
        self.onStart = onStart
        self.onEditWorkout = onEditWorkout
        self.onEditExercises = onEditExercises
        self.onClose = onClose
        self.preview = preview
    }

    public var body: some View {
        if let event = model.event(id: eventId) {
            EventSheetContent(model: model, event: event, onStart: onStart, onEditWorkout: onEditWorkout, onEditExercises: onEditExercises, onClose: onClose, preview: preview)
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
    let onStart: ((ScheduleEvent) -> Void)?
    let onEditWorkout: ((ScheduleEvent) -> Void)?
    let onEditExercises: ((ScheduleEvent) -> Void)?
    let onClose: () -> Void
    @State private var streams: ActivityStreamRecord?
    @State private var isToggling = false
    // W7 edit state.
    @State private var isEditingTitle = false
    @State private var titleDraft = ""
    @FocusState private var titleFocused: Bool
    @State private var isEditingSchedule: Bool
    @State private var dayDraft: DayKey
    @State private var startDraft: Int?
    @State private var endDraft: Int?
    @State private var confirmDelete: Bool
    @State private var isDeleting = false

    init(
        model: ScheduleModel, event: ScheduleEvent, onStart: ((ScheduleEvent) -> Void)?,
        onEditWorkout: ((ScheduleEvent) -> Void)?, onEditExercises: ((ScheduleEvent) -> Void)?,
        onClose: @escaping () -> Void, preview: EventSheet.PreviewState
    ) {
        self.model = model
        self.event = event
        self.onStart = onStart
        self.onEditWorkout = onEditWorkout
        self.onEditExercises = onEditExercises
        self.onClose = onClose
        _isEditingSchedule = State(initialValue: preview.editingSchedule)
        _confirmDelete = State(initialValue: preview.confirmingDelete)
        _dayDraft = State(initialValue: event.day)
        _startDraft = State(initialValue: event.startTime.flatMap(TimeLabel.minutes))
        _endDraft = State(initialValue: event.endTime.flatMap(TimeLabel.minutes))
    }

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
                    if isEditingSchedule { scheduleEditor }
                    if let streams { SyncMetricsView(record: streams) }
                    difficulty
                    actions
                    editActions
                    if let description = base.description, !description.isEmpty {
                        Text(description).apexBody()
                    }
                    sections
                    if let tags = base.tags, !tags.isEmpty {
                        FlowTags(tags: tags)
                    }
                    danger
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
        .task(id: event.id) {
            streams = await model.streams(for: event)
            // Opening the sheet is intent: make sure this workout can start offline.
            if onStart != nil { await model.prefetchTracker(for: event) }
        }
        .accessibilityIdentifier("schedule.event")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            RoundedRectangle(cornerRadius: 2).fill(palette.solid).frame(width: 4)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                WorkoutTypeBadge(rawType: event.type.rawValue)
                if isEditingTitle {
                    TextField("", text: $titleDraft)
                        .apexTitle()
                        .focused($titleFocused)
                        .submitLabel(.done)
                        .onSubmit { commitTitle() }
                        .accessibilityIdentifier("schedule.event.title.field")
                } else {
                    Button {
                        titleDraft = event.title
                        isEditingTitle = true
                        titleFocused = true
                    } label: {
                        Text(event.title)
                            .apexTitle()
                            .multilineTextAlignment(.leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("schedule.event.title")
                    .accessibilityHint("Tap to rename")
                }
                if let subtitle = base.subtitle, !subtitle.isEmpty {
                    Text(subtitle).apexBody()
                }
            }
            Spacer(minLength: 32)
        }
    }

    private var metaStrip: some View {
        FlowLayout(spacing: Spacing.md) {
            Button(action: beginScheduleEdit) {
                meta(.calendar, "\(MonthNames.weekdayLong[event.day.weekday - 1]), \(MonthNames.short[event.day.month - 1]) \(event.day.day)")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("schedule.event.date")
            .accessibilityHint("Tap to move")
            Button(action: beginScheduleEdit) {
                meta(.clock, TimeLabel.range(start: event.startTime, end: event.endTime) ?? "Add a time")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("schedule.event.time")
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

    /// The dots are 44pt targets (U1): tapping one sets the difficulty.
    private var difficulty: some View {
        let level = base.difficulty ?? 0
        return HStack(spacing: Spacing.sm) {
            HStack(spacing: 0) {
                ForEach(1...5, id: \.self) { i in
                    Button {
                        guard i != level else { return }
                        Task { await model.commit(.setDifficulty(event, i)) }
                    } label: {
                        Circle()
                            .fill(i <= level ? palette.solid : ApexColor.bgElevated)
                            .overlay(Circle().strokeBorder(i <= level ? .clear : ApexColor.borderSubtle, lineWidth: 1))
                            .frame(width: 10, height: 10)
                            .frame(width: 18, height: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Difficulty \(i) — \(Self.difficultyLabels[i])")
                    .accessibilityIdentifier("schedule.event.difficulty.\(i)")
                }
            }
            Text((1...5).contains(level) ? Self.difficultyLabels[level] : "Set difficulty")
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
        }
        .accessibilityElement(children: .contain)
    }

    /// Start Workout is offered for every event, like the web's `WorkoutModal`;
    /// a completed one reopens its editable session.
    private var actions: some View {
        HStack(spacing: Spacing.sm) {
            if let onStart {
                ApexButton(event.isCompleted ? "View / Edit Workout" : "Start Workout", kind: .secondary) {
                    onStart(event)
                }
                .accessibilityIdentifier("schedule.event.start")
            }
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
    }

    /// `WorkoutModal`'s Edit exercises / Edit workout.
    @ViewBuilder
    private var editActions: some View {
        if onEditExercises != nil || onEditWorkout != nil {
            HStack(spacing: Spacing.sm) {
                if let onEditExercises {
                    ApexButton("Edit exercises", kind: .secondary) { onEditExercises(event) }
                        .accessibilityIdentifier("schedule.event.edit.exercises")
                }
                if let onEditWorkout {
                    ApexButton("Edit workout", kind: .secondary) { onEditWorkout(event) }
                        .accessibilityIdentifier("schedule.event.edit.workout")
                }
            }
        }
    }

    /// The day and times through native pickers (U9); Done sends one
    /// reschedule. Moving the start drags the end along so the duration
    /// survives; an end at or before the start is refused before any request.
    private var scheduleEditor: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            DateField(event.isRecurring ? "Date (this day only)" : "Date", day: $dayDraft, identifier: "schedule.event.edit.date")
            HStack(spacing: Spacing.sm) {
                TimeField("Start", minutes: $startDraft, identifier: "schedule.event.edit.start")
                TimeField("End", minutes: $endDraft, identifier: "schedule.event.edit.end")
            }
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary) { isEditingSchedule = false }
                ApexButton("Done") { Task { await commitSchedule() } }
                    .accessibilityIdentifier("schedule.event.edit.done")
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgElevated.opacity(0.5), in: .rect(cornerRadius: Radius.lg))
        .onChange(of: startDraft) { old, new in
            // Drag the end along, preserving the duration (WorkoutModal.commitStartTime).
            guard let old, let new, let end = endDraft, end > old else { return }
            endDraft = min(new + (end - old), 23 * 60 + 59)
        }
    }

    /// `WorkoutModal`'s danger zone: a delete link that unfolds into the
    /// confirm, with the web's copy for a one-off and for a series.
    @ViewBuilder
    private var danger: some View {
        if confirmDelete {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text(event.isRecurring
                     ? "Delete this day only — anything logged for it goes too — or end the whole series, which leaves past sessions in your history."
                     : "Delete this workout? Everything logged for it — sets, reps, weights — goes with it.")
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Spacing.sm) {
                    ApexButton("Keep", kind: .secondary) { confirmDelete = false }
                        .disabled(isDeleting)
                    ApexButton(event.isRecurring ? "This day only" : "Delete workout", kind: .destructive, isLoading: isDeleting) {
                        Task { await remove(scope: .occurrence) }
                    }
                    .accessibilityIdentifier("schedule.event.delete.confirm")
                    if event.isRecurring {
                        ApexButton("Whole series", kind: .destructive, isLoading: isDeleting) {
                            Task { await remove(scope: .series) }
                        }
                        .accessibilityIdentifier("schedule.event.delete.series")
                    }
                }
            }
            .padding(Spacing.md)
            .background(ApexPalette.destructive.opacity(0.12), in: .rect(cornerRadius: Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexPalette.danger.opacity(0.4), lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("schedule.event.delete.panel")
        } else {
            Button {
                withAnimation(Motion.spring) { confirmDelete = true }
            } label: {
                Label("Delete workout", systemImage: ApexIcon.trash.systemName)
                    .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(ApexPalette.dangerText)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("schedule.event.delete")
        }
    }

    private enum DeleteScope { case occurrence, series }

    private func remove(scope: DeleteScope) async {
        isDeleting = true
        let edit: ScheduleEdit = event.isRecurring && scope == .occurrence ? .skipOccurrence(event) : .deleteEvent(event)
        let ok = await model.commit(edit)
        isDeleting = false
        if ok { onClose() }
    }

    private func commitTitle() {
        isEditingTitle = false
        let title = titleDraft.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty, title != event.title else { return }
        Task { await model.commit(.retitle(event, title: title)) }
    }

    private func beginScheduleEdit() {
        dayDraft = event.day
        startDraft = event.startTime.flatMap(TimeLabel.minutes)
        endDraft = event.endTime.flatMap(TimeLabel.minutes)
        withAnimation(Motion.spring) { isEditingSchedule = true }
    }

    private func commitSchedule() async {
        if let start = startDraft, let end = endDraft, end <= start {
            ToastBus.shared.post("End time must be after the start time", level: .failure)
            return
        }
        var override = OccurrenceOverride()
        if dayDraft != event.day { override.date = dayDraft.string }
        let start = startDraft.map(TimeLabel.stored(minutes:))
        let end = endDraft.map(TimeLabel.stored(minutes:))
        if start != event.startTime, let start { override.startTime = start }
        if end != event.endTime, let end { override.endTime = end }
        isEditingSchedule = false
        guard override != OccurrenceOverride() else { return }
        await model.commit(.reschedule(event, override))
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
