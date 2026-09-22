import ApexCore
import ApexUI
import SwiftUI

/// The event sheet (`WorkoutModal.tsx`): the read view from W2 plus its edit
/// paths (W7) — inline title, the day and times through native pickers,
/// difficulty, Edit exercises, Edit workout, Delete (this day / the series).
/// Renders from the model by id, never from a copy, so a completion or a
/// realtime edit shows while the sheet is up.
///
/// ux-review §3.3: content first, actions in a bottom bar — Start Workout is
/// the one primary, everything else lives in its menu — and the metadata is
/// one Planned · Actual block rather than 13 icon+value pairs that showed the
/// plan and the measured actual side by side without saying which was which.
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
        /// A refusal already showing in the schedule editor.
        public var scheduleProblem: String?
        public init(editingSchedule: Bool = false, confirmingDelete: Bool = false, scheduleProblem: String? = nil) {
            self.editingSchedule = editingSchedule
            self.confirmingDelete = confirmingDelete
            self.scheduleProblem = scheduleProblem
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
    /// The schedule editor's last refusal. A refusal of the sheet's own action
    /// stays inline, next to the buttons that asked (design-spec §5), so it
    /// lives here until the next edit.
    @State private var scheduleProblem: String?
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
        _scheduleProblem = State(initialValue: preview.scheduleProblem)
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
                    whenLine
                    if isEditingSchedule { scheduleEditor }
                    PlannedActualBlock(event: event, record: streams)
                    if let streams { SyncMetricsView(record: streams) }
                    difficulty
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
                .padding(.bottom, Spacing.xl)
            }
        }
        // Before the inset, not after: an identifier applied over a
        // `safeAreaInset` is handed to every element inside it, which cost the
        // bar's own identifiers (Start Workout came back as `schedule.event`).
        .accessibilityIdentifier("schedule.event")
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
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
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            RoundedRectangle(cornerRadius: 2).fill(palette.solid).frame(width: 4)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    WorkoutTypeBadge(rawType: event.type.rawValue)
                    // The completion used to be readable only off a button
                    // label ("Completed"); with the control in the menu the
                    // state has to be stated where the state belongs.
                    if event.isCompleted {
                        Label("Completed", systemImage: ApexIcon.checkCircle.systemName)
                            .font(.apex(.display, size: TypeScale.micro, weight: .semibold, relativeTo: .caption2))
                            .foregroundStyle(ApexPalette.positive)
                            .accessibilityIdentifier("schedule.event.completed")
                    }
                }
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

    /// Where and when, as one line of plain text above the numbers — no icons
    /// (ux-review §3.3). The date and the time still open the schedule editor.
    private var whenLine: some View {
        FlowLayout(spacing: Spacing.xs) {
            Button(action: beginScheduleEdit) {
                lineText("\(MonthNames.weekdayLong[event.day.weekday - 1]), \(MonthNames.short[event.day.month - 1]) \(event.day.day)")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("schedule.event.date")
            .accessibilityHint("Tap to move")
            separator
            Button(action: beginScheduleEdit) {
                lineText(TimeLabel.range(start: event.startTime, end: event.endTime) ?? "Add a time")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("schedule.event.time")
            if let location = base.location, !location.isEmpty {
                separator
                lineText(location)
            }
        }
    }

    private func lineText(_ text: String) -> some View {
        Text(text)
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textSecondary)
            .contentShape(.rect)
    }

    private var separator: some View {
        Text("·")
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textMuted)
            .accessibilityHidden(true)
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

    /// One primary and one menu, in a `safeAreaInset` bar the content scrolls
    /// under (ux-review §3.3). The delete confirmation takes the bar over
    /// rather than opening a second surface, so the day/series choice is
    /// where the tap that asked for it was.
    private var bottomBar: some View {
        VStack(spacing: 0) {
            if confirmDelete {
                deleteConfirm
            } else {
                HStack(spacing: Spacing.sm) {
                    if let onStart {
                        ApexButton(event.isCompleted ? "View / Edit Workout" : "Start Workout") {
                            onStart(event)
                        }
                        .accessibilityIdentifier("schedule.event.start")
                    }
                    moreMenu(compact: onStart != nil)
                }
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.vertical, Spacing.md)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    /// Everything that is not the primary: completion, both editors, delete.
    /// Each keeps the identifier it had as a button — the smoke opens the menu
    /// and taps the same name.
    private func moreMenu(compact: Bool) -> some View {
        Menu {
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                isToggling = true
                Task {
                    await model.toggleCompletion(event)
                    isToggling = false
                }
            } label: {
                Label(event.isCompleted ? "Mark incomplete" : "Mark as Complete",
                      systemImage: event.isCompleted ? ApexIcon.circle.systemName : ApexIcon.check.systemName)
            }
            .disabled(isToggling)
            .accessibilityIdentifier("schedule.event.complete")

            if let onEditExercises {
                Button {
                    onEditExercises(event)
                } label: {
                    Label("Edit exercises", systemImage: ApexIcon.dumbbell.systemName)
                }
                .accessibilityIdentifier("schedule.event.edit.exercises")
            }
            if let onEditWorkout {
                Button {
                    onEditWorkout(event)
                } label: {
                    Label("Edit workout", systemImage: ApexIcon.edit.systemName)
                }
                .accessibilityIdentifier("schedule.event.edit.workout")
            }

            Divider()

            Button(role: .destructive) {
                Motion.animate { confirmDelete = true }
            } label: {
                Label("Delete workout", systemImage: ApexIcon.trash.systemName)
            }
            .accessibilityIdentifier("schedule.event.delete")
        } label: {
            Group {
                if compact {
                    ApexIcon.kebab.image.font(.system(size: 17, weight: .medium))
                } else {
                    Text("More").font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
                }
            }
            .foregroundStyle(ApexColor.textPrimary)
            .frame(maxWidth: compact ? CGFloat(56) : .infinity, minHeight: 44)
            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
            .contentShape(.rect)
            // The label is the element the tree sees, so it carries the name:
            // left to itself the glyph reported as an `Image` called `ellipsis`.
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("More")
            .accessibilityIdentifier("schedule.event.more")
        }
        .frame(maxWidth: compact ? CGFloat(56) : .infinity)
    }

    /// `WorkoutModal`'s danger zone, with the web's copy for a one-off and for
    /// a series.
    private var deleteConfirm: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(event.isRecurring
                 ? "Delete this day only — anything logged for it goes too — or end the whole series, which leaves past sessions in your history."
                 : "Delete this workout? Everything logged for it — sets, reps, weights — goes with it.")
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Spacing.sm) {
                ApexButton("Keep", kind: .secondary) { Motion.animate { confirmDelete = false } }
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule.event.delete.panel")
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
            if let scheduleProblem {
                InlineError(scheduleProblem, identifier: "schedule.event.edit.problem")
            }
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary) {
                    scheduleProblem = nil
                    isEditingSchedule = false
                }
                ApexButton("Done") { Task { await commitSchedule() } }
                    .accessibilityIdentifier("schedule.event.edit.done")
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgElevated.opacity(0.5), in: .rect(cornerRadius: Radius.lg))
        .onChange(of: startDraft) { old, new in
            scheduleProblem = nil
            // Drag the end along, preserving the duration (WorkoutModal.commitStartTime).
            guard let old, let new, let end = endDraft, end > old else { return }
            endDraft = min(new + (end - old), 23 * 60 + 59)
        }
        .onChange(of: endDraft) { scheduleProblem = nil }
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
        Motion.animate { isEditingSchedule = true }
    }

    private func commitSchedule() async {
        if let start = startDraft, let end = endDraft, end <= start {
            scheduleProblem = "End time must be after the start time"
            return
        }
        scheduleProblem = nil
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
                                ExerciseRow(exercise: exercise)
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

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(exercise.name)
                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
            if let meta = metaLine {
                // The prescription is text, not a signal: it was the workout
                // type's colour, which meant nothing here (ux-review §3.3).
                Text(meta)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textSecondary)
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

/// The plan and what actually happened, in one block (ux-review §3.3). Before
/// this the sheet showed distance, elevation and heart rate twice — once from
/// the plan, once from the provider — with nothing saying which was which.
///
/// With no synced record there is nothing to compare, so the ACTUAL column is
/// dropped rather than filled with dashes.
struct PlannedActualBlock: View {
    let event: ScheduleEvent
    let record: ActivityStreamRecord?

    struct Row: Identifiable {
        let label: String
        let planned: String?
        let actual: String?
        var id: String { label }
    }

    var body: some View {
        let rows = Self.rows(event: event, record: record)
        if !rows.isEmpty {
            Grid(alignment: .leading, horizontalSpacing: Spacing.lg, verticalSpacing: Spacing.sm) {
                GridRow {
                    Color.clear.frame(width: 0, height: 0)
                    Text("Planned").apexFieldLabel()
                    if record != nil { actualHeader }
                }
                ForEach(rows) { row in
                    GridRow {
                        Text(row.label)
                            .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                        value(row.planned)
                        if record != nil { value(row.actual) }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("schedule.event.metrics")
        }
    }

    /// The old orange "Synced from COROS" pill, demoted to what it always was:
    /// a caption saying where the right-hand column came from.
    private var actualHeader: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Actual").apexFieldLabel()
            Text("Synced from \(SyncMetricsFormatter.providerLabel(record?.provider ?? ""))")
                .font(.apex(.display, size: TypeScale.micro, relativeTo: .caption2))
                .foregroundStyle(ApexColor.textMuted)
                .accessibilityIdentifier("schedule.event.synced")
        }
    }

    private func value(_ text: String?) -> some View {
        Text(text ?? "—")
            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
            .monospacedDigit()
            .foregroundStyle(text == nil ? ApexColor.textMuted : ApexColor.textPrimary)
    }

    /// One row per measure either side has something to say about.
    static func rows(event: ScheduleEvent, record: ActivityStreamRecord?) -> [Row] {
        let base = event.base
        let measured = record.map { SyncMetricsFormatter.items($0.summary) } ?? []
        func actual(_ kind: SyncMetricItem.Kind) -> String? { measured.first { $0.kind == kind }?.text }

        var rows: [Row] = []
        func add(_ label: String, _ planned: String?, _ actual: String?) {
            guard planned != nil || actual != nil else { return }
            rows.append(Row(label: label, planned: planned, actual: actual))
        }

        add("Duration", base.estimatedDuration.map { TimeLabel.duration(minutes: $0) }, record.flatMap(Self.elapsed))
        add("Distance", base.cardioTargets?.distance.flatMap { $0.isEmpty ? nil : $0 }, actual(.distance))
        add("Elevation", base.cardioTargets?.elevationGain.flatMap { $0.isEmpty ? nil : $0 }, actual(.elevation))
        add("Heart rate", base.cardioTargets?.avgHeartRate.map { "\(Int($0)) bpm" }, actual(.heartRate))
        add("Calories", nil, actual(.calories))
        // The formatter prefixes the load with its own name for the old badge
        // strip; in a labelled row that reads "Load  Load 88".
        add("Load", nil, actual(.load).map { $0.replacingOccurrences(of: "Load ", with: "") })
        add("Max grade", base.climbingTargets?.maxGrade.flatMap { $0.isEmpty ? nil : $0 }, nil)
        add("Pitches", base.climbingTargets?.totalPitches.map { "\($0)" }, nil)
        return rows
    }

    /// The measured duration is the last sample's clock, rounded to the minute
    /// so it reads beside a planned "45m" — the summary row carries no time.
    private static func elapsed(_ record: ActivityStreamRecord) -> String? {
        let seconds = max(record.hrSamples.last?.seconds ?? 0, record.gpsSamples.last?.seconds ?? 0)
        guard seconds > 0 else { return nil }
        return TimeLabel.duration(minutes: max(1, Int((seconds / 60).rounded())))
    }
}

/// `SyncMetrics.tsx`'s charts. The numbers it used to carry moved into
/// `PlannedActualBlock`, beside the plan they are meant to be read against.
struct SyncMetricsView: View {
    let record: ActivityStreamRecord

    @ViewBuilder
    var body: some View {
        if record.hrSamples.count > 1 || record.gpsSamples.count > 1 {
            StreamChartsView(record: record)
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
