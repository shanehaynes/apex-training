import ApexCore
import ApexUI
import Foundation
import Observation

/// The builder's state (`WorkoutBuilderView.tsx` + `TemplateSearch` +
/// `BuilderForm` + `BuilderCoachPanel`): one `WorkoutDraft` every input writes
/// into and Apply reads from, the search step, the scope bar, and a builder-mode
/// coach whose reduces land on the same draft. Everything about rows, template
/// identity and anchor snapping is the server's (`/api/workout-draft`).
@MainActor
@Observable
public final class BuilderModel {
    public enum Step: Sendable { case search, form }
    public enum Scope: Sendable { case occurrence, series }

    public private(set) var draft: WorkoutDraft
    public private(set) var step: Step
    public private(set) var errors: [String: String] = [:]
    public private(set) var isSaving = false
    public private(set) var templates: [WorkoutTemplate] = []
    public private(set) var definitions: [ExerciseDefinition] = []
    public private(set) var coach: CoachModel?
    public var query = ""
    public var typeFilter: WorkoutType?
    public var choosingScope = false
    public var coachOpen = false
    public var confirmDiscard = false

    public let editing: ScheduleEvent?
    public let route: BuilderRoute
    let scheduleModel: ScheduleModel
    private var model: ScheduleModel { scheduleModel }
    private let coachServices: CoachServices?
    private var original: WorkoutDraft

    public init(model: ScheduleModel, route: BuilderRoute, coachServices: CoachServices? = nil) {
        self.scheduleModel = model
        self.route = route
        self.coachServices = coachServices
        let initial: WorkoutDraft
        switch route {
        case .create(let date):
            editing = nil
            initial = .empty(date: date.string)
            step = .search
        case .edit(let eventId):
            let event = model.event(id: eventId)
            editing = event
            initial = event.map(WorkoutDraft.init(event:)) ?? .empty(date: model.selectedDay.string)
            step = .form
        }
        draft = initial
        original = initial
    }

    // MARK: - Lifecycle

    public func start() async {
        templates = await model.templates()
        definitions = await model.definitions()
        guard coach == nil, let coachServices else { return }
        let coach = CoachModel(
            services: coachServices, mode: .builder, draft: try? draft.jsonValue(),
            onDraft: { [weak self] reduced in self?.apply(reduced: reduced) },
            placeholder: "e.g. \"Make this a 20 min AMRAP of…\""
        )
        self.coach = coach
        await coach.start()
    }

    public func shutdown() {
        coach?.shutdown()
    }

    // MARK: - Derived

    public var isEditing: Bool { editing != nil }
    /// Editing a recurring series asks which scope the save applies to.
    public var asksScope: Bool { editing?.isRecurring ?? false }
    /// Unsaved edits: what a swipe-down would lose. A picked template with no
    /// edits is not dirty — closing loses nothing the library does not hold.
    public var isDirty: Bool { draft != original }
    public var canCoach: Bool { coach != nil && step == .form }

    public var title: String {
        if isEditing { return "Edit Workout" }
        if step == .search { return "Add Workout" }
        return draft.templateId != nil ? draft.title : "New Workout"
    }

    public var subtitle: String {
        guard let day = DayKey(draft.date) else { return draft.date }
        return "\(MonthNames.weekdayLong[day.weekday - 1]), \(MonthNames.short[day.month - 1]) \(day.day)"
    }

    /// `TemplateSearch`: unarchived, the type chip, a substring over title and
    /// tags, newest save first.
    public var filteredTemplates: [WorkoutTemplate] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return templates
            .filter { $0.archivedAt == nil }
            .filter { typeFilter == nil || $0.type == typeFilter }
            .filter { template in
                guard !needle.isEmpty else { return true }
                if template.title.lowercased().contains(needle) { return true }
                return (template.tags ?? []).contains { $0.lowercased().contains(needle) }
            }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
    }

    // MARK: - The draft

    /// Every input writes here; the coach's next reduce starts from here too.
    public func update(_ change: (inout WorkoutDraft) -> Void) {
        var next = draft
        change(&next)
        draft = next
        errors = [:]
        pushDraftToCoach()
    }

    public func setType(_ type: WorkoutType) {
        update { $0 = $0.withType(type) }
    }

    /// The coach reduced the draft on the server: it replaces the form.
    public func apply(reduced: JSONValue) {
        guard let next = try? WorkoutDraft(jsonValue: reduced) else { return }
        draft = next
        errors = [:]
    }

    private func pushDraftToCoach() {
        guard let coach, let json = try? draft.jsonValue() else { return }
        coach.updateDraft(json)
    }

    // MARK: - Search step

    public func pick(_ template: WorkoutTemplate) {
        draft = WorkoutDraft(template: template, date: draft.date)
        original = draft
        step = .form
        pushDraftToCoach()
    }

    public func startBlank() {
        draft = .empty(date: draft.date, title: query.trimmingCharacters(in: .whitespaces))
        step = .form
        pushDraftToCoach()
    }

    public func backToSearch() {
        step = .search
        coachOpen = false
    }

    public func archive(_ template: WorkoutTemplate) async {
        if await model.archiveTemplate(id: template.id, archived: true) {
            templates = await model.templates()
        }
    }

    public func createDefinition(name: String, category: String, isUnilateral: Bool) async -> ExerciseDefinition? {
        let created = await model.createDefinition(name: name, category: category, isUnilateral: isUnilateral)
        if let created { definitions.append(created) }
        return created
    }

    // MARK: - Apply

    /// `validate()` then Apply / Save changes. Returns true when the sheet
    /// should close. The server re-validates; its `ok:false` lands here too.
    @discardableResult
    public func apply(scope: Scope? = nil) async -> Bool {
        if let problem = draft.problem {
            ToastBus.shared.post(problem, level: .failure)
            return false
        }
        errors = Entries.unilateralViolations(draft.lists, definitions: definitions)
        guard errors.isEmpty else { return false }

        var sent = draft
        let action: WorkoutDraftAction
        if let editing {
            if editing.isRecurring, scope == .occurrence {
                // Detach: the repeat picker doesn't apply — a detached day cannot itself repeat.
                sent.repeatRule = .off
                action = .detach(eventId: editing.id, occurrenceDate: editing.keyDate)
            } else {
                action = .update(eventId: editing.id)
            }
        } else {
            action = .create
        }

        isSaving = true
        defer { isSaving = false }
        guard let response = await model.applyDraft(sent, action: action) else { return false }
        guard response.ok else {
            if let problem = response.problem { ToastBus.shared.post(problem, level: .failure) }
            errors = response.violations ?? [:]
            return false
        }
        let copy: String = switch action {
        case .create: "Workout added"
        case .update: "Workout updated"
        case .detach: "Saved — this day now stands alone"
        }
        ToastBus.shared.post(copy, level: .success)
        original = draft
        return true
    }
}
