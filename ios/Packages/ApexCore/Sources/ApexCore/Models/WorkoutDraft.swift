import Foundation

/// `WorkoutDraft` from `src/lib/builder/draft.ts` — one plain value holding
/// everything the workout builder edits, in the exact JSON shape the server
/// reduces (`POST /api/coach-tool update_workout_draft`) and applies
/// (`POST /api/workout-draft`). Numeric fields are strings deliberately: an
/// input must be clearable; the server parses at Apply. Swift owns the form
/// state (constructors, `withType`, the instant `problem`) and nothing else —
/// serialisation to rows, template identity and anchor snapping stay server
/// side (D-008, D-027).
public struct WorkoutDraft: Codable, Sendable, Equatable {
    public struct Sections: Codable, Sendable, Equatable {
        public var warmup: [Exercise]
        public var exercises: [Exercise]
        public var cooldown: [Exercise]

        public init(warmup: [Exercise] = [], exercises: [Exercise] = [], cooldown: [Exercise] = []) {
            self.warmup = warmup
            self.exercises = exercises
            self.cooldown = cooldown
        }

        public static let empty = Sections()
    }

    /// Set when the draft came from (or was title-matched to) a library template.
    public var templateId: String?
    public var title: String
    public var type: WorkoutType
    /// `""` = unspecified. Climbing types force `"climbing"` (`withType`).
    public var sport: String
    public var scoringType: String
    /// AMRAP only: working-window length in minutes.
    public var timeCap: String
    /// `yyyy-MM-dd`; times are `HH:mm` input values, `""` = unset.
    public var date: String
    public var startTime: String
    public var endTime: String
    public var duration: String
    public var difficulty: Int
    public var description: String
    public var location: String
    /// Comma-joined, as typed; parsed at Apply time.
    public var tags: String
    public var distance: String
    public var elevationGain: String
    public var avgHeartRate: String
    public var maxGrade: String
    public var totalPitches: String
    public var lists: Sections
    /// Pass-through only — no builder UI edits equipment yet.
    public var equipment: [String]
    /// Repeat schedule — a calendar concern, never part of the template.
    /// (`repeat` on the wire; the word is a Swift keyword.)
    public var repeatRule: DraftRepeat

    enum CodingKeys: String, CodingKey {
        case templateId, title, type, sport, scoringType, timeCap, date, startTime, endTime, duration, difficulty
        case description, location, tags, distance, elevationGain, avgHeartRate, maxGrade, totalPitches, lists, equipment
        case repeatRule = "repeat"
    }

    // MARK: - Web constants (`TYPE_ORDER`, `TYPE_DURATION`, `TYPE_CATEGORY`, `WORKOUT_COLORS[t].label`)

    /// Chip order in the form.
    public static let typeOrder: [WorkoutType] = [.weights, .climbing, .outdoorClimbing, .cardio, .yoga, .stretching, .morningRoutine]

    public static func defaultDuration(for type: WorkoutType) -> Int {
        switch type {
        case .weights: 60
        case .climbing: 90
        case .outdoorClimbing: 240
        case .cardio: 45
        case .yoga: 45
        case .stretching: 20
        case .morningRoutine: 30
        case .unknown: 60
        }
    }

    /// The library category the exercise picker pre-filters to.
    public static func pickerCategory(for type: WorkoutType) -> String {
        switch type {
        case .weights: "strength"
        case .climbing: "skill"
        case .outdoorClimbing: "climbing"
        case .cardio: "cardio"
        case .yoga, .morningRoutine: "mobility"
        case .stretching: "stretch"
        case .unknown: "strength"
        }
    }

    /// The web's type label — what a never-customised title follows.
    public static func label(for type: WorkoutType) -> String {
        switch type {
        case .weights: "Strength"
        case .climbing: "Indoor Climbing"
        case .outdoorClimbing: "Outdoor Climbing"
        case .cardio: "Cardio"
        case .yoga: "Yoga & Mobility"
        case .stretching: "Stretching"
        case .morningRoutine: "Morning Routine"
        case .unknown(let raw): raw
        }
    }

    public static let sportOptions: [(value: String, label: String)] = [
        ("", "No sport"), ("running", "Running"), ("biking", "Biking"), ("swimming", "Swimming"), ("other", "Other sport"),
    ]
    public static let scoringOptions: [(value: String, label: String)] = [("strength", "Strength"), ("for-time", "For Time"), ("amrap", "AMRAP")]
    public static let difficultyLabels = ["", "Easy", "Moderate", "Challenging", "Hard", "Maximal"]

    // MARK: - Constructors

    /// `emptyDraft`.
    public static func empty(date: String, title: String = "") -> WorkoutDraft {
        WorkoutDraft(
            templateId: nil, title: title, type: .weights, sport: "", scoringType: "strength", timeCap: "",
            date: date, startTime: "", endTime: "", duration: String(defaultDuration(for: .weights)),
            difficulty: 3, description: "", location: "", tags: "", distance: "", elevationGain: "", avgHeartRate: "",
            maxGrade: "", totalPitches: "", lists: .empty, equipment: [], repeatRule: .off
        )
    }

    /// `draftFromTemplate`: placement on `date`, no times, never repeating.
    public init(template t: WorkoutTemplate, date: String) {
        templateId = t.id
        title = t.title
        type = t.type
        sport = t.sport ?? ""
        scoringType = t.scoringType ?? "strength"
        timeCap = t.timeCapMinutes.map(String.init) ?? ""
        self.date = date
        startTime = ""
        endTime = ""
        duration = String(t.estimatedDuration ?? WorkoutDraft.defaultDuration(for: t.type))
        difficulty = t.difficulty ?? 3
        description = t.description ?? ""
        location = t.location ?? ""
        tags = (t.tags ?? []).joined(separator: ", ")
        distance = t.cardioTargets?.distance ?? ""
        elevationGain = t.cardioTargets?.elevationGain ?? ""
        avgHeartRate = t.cardioTargets?.avgHeartRate.map { String(Int($0)) } ?? ""
        maxGrade = t.climbingTargets?.maxGrade ?? ""
        totalPitches = t.climbingTargets?.totalPitches.map(String.init) ?? ""
        lists = Sections(warmup: t.warmup ?? [], exercises: t.exercises ?? [], cooldown: t.cooldown ?? [])
        equipment = t.equipment ?? []
        repeatRule = .off
    }

    /// `draftFromEvent`, from the occurrence the sheet opened: the day and
    /// times are the occurrence's, everything else the base's.
    public init(event: ScheduleEvent) {
        let base = event.base
        templateId = base.templateId
        title = base.title
        type = base.type
        sport = base.sport ?? ""
        scoringType = base.scoringType ?? "strength"
        timeCap = base.timeCapMinutes.map(String.init) ?? ""
        date = event.date
        startTime = TimeLabel.inputTime(event.startTime)
        endTime = TimeLabel.inputTime(event.endTime)
        duration = String(base.estimatedDuration ?? WorkoutDraft.defaultDuration(for: base.type))
        difficulty = base.difficulty ?? 3
        description = base.description ?? ""
        location = base.location ?? ""
        tags = (base.tags ?? []).joined(separator: ", ")
        distance = base.cardioTargets?.distance ?? ""
        elevationGain = base.cardioTargets?.elevationGain ?? ""
        avgHeartRate = base.cardioTargets?.avgHeartRate.map { String(Int($0)) } ?? ""
        maxGrade = base.climbingTargets?.maxGrade ?? ""
        totalPitches = base.climbingTargets?.totalPitches.map(String.init) ?? ""
        lists = Sections(warmup: base.warmup ?? [], exercises: base.exercises ?? [], cooldown: base.cooldown ?? [])
        equipment = base.equipment ?? []
        repeatRule = Repeat.fromRule(event.isRecurring ? base.recurrenceRule : nil)
    }

    public init(
        templateId: String?, title: String, type: WorkoutType, sport: String, scoringType: String, timeCap: String,
        date: String, startTime: String, endTime: String, duration: String, difficulty: Int, description: String,
        location: String, tags: String, distance: String, elevationGain: String, avgHeartRate: String,
        maxGrade: String, totalPitches: String, lists: Sections, equipment: [String], repeatRule: DraftRepeat
    ) {
        self.templateId = templateId
        self.title = title
        self.type = type
        self.sport = sport
        self.scoringType = scoringType
        self.timeCap = timeCap
        self.date = date
        self.startTime = startTime
        self.endTime = endTime
        self.duration = duration
        self.difficulty = difficulty
        self.description = description
        self.location = location
        self.tags = tags
        self.distance = distance
        self.elevationGain = elevationGain
        self.avgHeartRate = avgHeartRate
        self.maxGrade = maxGrade
        self.totalPitches = totalPitches
        self.lists = lists
        self.equipment = equipment
        self.repeatRule = repeatRule
    }

    // MARK: - Form rules

    public var isClimbingType: Bool { type == .climbing || type == .outdoorClimbing }

    /// `withType`: a title the user never customised (empty, or still some
    /// type's default label) follows the new type, as does a duration still
    /// at some type's default. Climbing types imply the sport; leaving
    /// climbing drops the implication (a deliberately picked sport survives).
    public func withType(_ newType: WorkoutType) -> WorkoutDraft {
        var next = self
        let titleIsDefault = title.isEmpty || WorkoutDraft.typeOrder.contains { title == WorkoutDraft.label(for: $0) }
        let durationIsDefault = WorkoutDraft.typeOrder.contains { duration == String(WorkoutDraft.defaultDuration(for: $0)) }
        let isClimbing = newType == .climbing || newType == .outdoorClimbing
        next.type = newType
        next.sport = isClimbing ? "climbing" : (sport == "climbing" ? "" : sport)
        if titleIsDefault { next.title = WorkoutDraft.label(for: newType) }
        if durationIsDefault || duration.isEmpty { next.duration = String(WorkoutDraft.defaultDuration(for: newType)) }
        return next
    }

    /// `draftProblem`: the first user-facing validation problem, or nil. The
    /// server re-runs the same check before it writes; this one is for the
    /// instant toast.
    public var problem: String? {
        if title.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the workout a title" }
        guard let minutes = Int(duration.trimmingCharacters(in: .whitespaces)), minutes > 0 else {
            return "Duration must be a positive number of minutes"
        }
        if scoringType == "amrap" {
            guard let cap = Int(timeCap.trimmingCharacters(in: .whitespaces)), cap > 0 else { return "AMRAP needs a time cap in minutes" }
        }
        return Repeat.problem(repeatRule, anchorDate: date)
    }

    // MARK: - JSON bridge (the coach session carries the draft as `JSONValue`)

    public func jsonValue() throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(self))
    }

    public init(jsonValue: JSONValue) throws {
        self = try JSONDecoder().decode(WorkoutDraft.self, from: JSONEncoder().encode(jsonValue))
    }
}

/// What `POST /api/workout-draft` should do with the draft.
public enum WorkoutDraftAction: Sendable, Equatable {
    case create
    /// A one-off (with its schedule) or a whole series (without it).
    case update(eventId: String)
    /// This occurrence only: it leaves the series as a standalone event.
    /// `occurrenceDate` is `ScheduleEvent.keyDate`.
    case detach(eventId: String, occurrenceDate: String)
}

/// `POST /api/workout-draft` — `ok: false` is the web's own pre-save toast
/// (and per-entry unilateral violations), on 200, with nothing written.
public struct WorkoutDraftResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let problem: String?
    public let violations: [String: String]?
    public let action: String?
    public let id: String?
    public let templateId: String?
    public let date: String?
    public let completedOnCreate: Bool?
    public let isRecurring: Bool?
    public let detachedFrom: String?
    public let occurrenceDate: String?
    /// The event as `/api/schedule` serves its base.
    public let event: WorkoutEventBase?
}
