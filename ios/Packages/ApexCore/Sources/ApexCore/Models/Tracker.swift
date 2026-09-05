import Foundation

/// `POST /api/workout-sessions { action: "bootstrap" }` (W3) — everything the
/// tracker needs to open, already grouped by the server. With `peek: true`
/// (W4) the server reads without creating the session, so `session` is nil
/// for a workout that has never started.
///
/// Note the casing split: `session` is a raw DB row and is snake_case, while
/// `event` and `groups` are API shapes and are camelCase. That is why these
/// models declare `CodingKeys` explicitly instead of relying on a
/// `.convertFromSnakeCase` decoder — one global strategy cannot serve both.
///
/// The tracker structs are `var` because `TrackerEditor` (ApexCore/Tracker)
/// edits them in place; the server remains the only thing that *builds* them.
public struct TrackerBootstrap: Codable, Sendable, Equatable {
    public var session: Session?
    public let event: WorkoutEventBase?
    public var groups: [TrackedSectionGroup]
    public let scored: Bool
    public var prs: [PersonalRecord]?
    public var scoreRecord: ScoreRecord?

    public init(
        session: Session?, event: WorkoutEventBase?, groups: [TrackedSectionGroup],
        scored: Bool, prs: [PersonalRecord]? = nil, scoreRecord: ScoreRecord? = nil
    ) {
        self.session = session
        self.event = event
        self.groups = groups
        self.scored = scored
        self.prs = prs
        self.scoreRecord = scoreRecord
    }

    public struct Session: Codable, Sendable, Equatable {
        public var id: String
        public var userId: String
        public var eventId: String
        public var eventDate: String
        public var startedAt: String?
        public var finishedAt: String?
        public var updatedAt: String?
        public var totalDurationSeconds: Int?
        public var coachSummary: String?
        public var templateId: String?
        public var scoreType: String?
        public var scoreTimeSeconds: Int?
        public var scoreRounds: Int?
        public var scoreReps: Int?

        public init(
            id: String, userId: String, eventId: String, eventDate: String,
            startedAt: String? = nil, finishedAt: String? = nil, updatedAt: String? = nil,
            totalDurationSeconds: Int? = nil, coachSummary: String? = nil, templateId: String? = nil,
            scoreType: String? = nil, scoreTimeSeconds: Int? = nil, scoreRounds: Int? = nil, scoreReps: Int? = nil
        ) {
            self.id = id
            self.userId = userId
            self.eventId = eventId
            self.eventDate = eventDate
            self.startedAt = startedAt
            self.finishedAt = finishedAt
            self.updatedAt = updatedAt
            self.totalDurationSeconds = totalDurationSeconds
            self.coachSummary = coachSummary
            self.templateId = templateId
            self.scoreType = scoreType
            self.scoreTimeSeconds = scoreTimeSeconds
            self.scoreRounds = scoreRounds
            self.scoreReps = scoreReps
        }

        enum CodingKeys: String, CodingKey {
            case id
            case userId = "user_id"
            case eventId = "event_id"
            case eventDate = "event_date"
            case startedAt = "started_at"
            case finishedAt = "finished_at"
            case updatedAt = "updated_at"
            case totalDurationSeconds = "total_duration_seconds"
            case coachSummary = "coach_summary"
            case templateId = "template_id"
            case scoreType = "score_type"
            case scoreTimeSeconds = "score_time_seconds"
            case scoreRounds = "score_rounds"
            case scoreReps = "score_reps"
        }
    }
}

public struct TrackedSectionGroup: Codable, Sendable, Equatable {
    public let section: String
    public let label: String
    public var exercises: [TrackedExercise]

    public init(section: String, label: String, exercises: [TrackedExercise]) {
        self.section = section
        self.label = label
        self.exercises = exercises
    }
}

public struct TrackedExercise: Codable, Sendable, Equatable {
    public let section: String
    public var exercise: Exercise
    /// The planned movement's name once the logged rows were relabelled onto
    /// another definition (`swap-exercise`); nil when the plan was followed.
    public var substitutedFrom: String?
    public let isCardio: Bool
    public var sets: [TrackedSet]
    public var cardio: CardioLog?

    public init(
        section: String, exercise: Exercise, substitutedFrom: String? = nil,
        isCardio: Bool, sets: [TrackedSet], cardio: CardioLog? = nil
    ) {
        self.section = section
        self.exercise = exercise
        self.substitutedFrom = substitutedFrom
        self.isCardio = isCardio
        self.sets = sets
        self.cardio = cardio
    }
}

public struct TrackedSet: Codable, Sendable, Equatable {
    public let setNumber: Int
    public var planned: PlannedSet?
    public var actualWeight: String?
    public var actualReps: String?
    public var actualDuration: String?
    /// Persisted at least once — an untouched planned set gets zero-filled at Finish.
    public var isLogged: Bool
    public var isAutofilled: Bool
    /// Added in the tracker beyond the plan — removable, never zero-filled.
    public var isExtra: Bool
    /// The greyed-out suggestion the web calls a shadow. It commits on tap, never
    /// on its own.
    public var shadow: ShadowValues?

    public init(
        setNumber: Int, planned: PlannedSet? = nil,
        actualWeight: String? = "", actualReps: String? = "", actualDuration: String? = "",
        isLogged: Bool = false, isAutofilled: Bool = false, isExtra: Bool = false, shadow: ShadowValues? = nil
    ) {
        self.setNumber = setNumber
        self.planned = planned
        self.actualWeight = actualWeight
        self.actualReps = actualReps
        self.actualDuration = actualDuration
        self.isLogged = isLogged
        self.isAutofilled = isAutofilled
        self.isExtra = isExtra
        self.shadow = shadow
    }
}

public struct PlannedSet: Codable, Sendable, Equatable {
    public let setNumber: Int
    public let targetWeight: String?
    public let targetReps: String?
    public let targetDuration: String?

    public init(setNumber: Int, targetWeight: String? = nil, targetReps: String? = nil, targetDuration: String? = nil) {
        self.setNumber = setNumber
        self.targetWeight = targetWeight
        self.targetReps = targetReps
        self.targetDuration = targetDuration
    }
}

/// Last session's actuals for a set (`LastSetActuals` in plan.ts).
public struct ShadowValues: Codable, Sendable, Equatable {
    public var weight: String?
    public var reps: String?
    public var duration: String?

    public init(weight: String? = nil, reps: String? = nil, duration: String? = nil) {
        self.weight = weight
        self.reps = reps
        self.duration = duration
    }
}

/// Last session's cardio metrics (`CardioShadow` in plan.ts) — committed per
/// field, not per row: the four metrics are independent enough that one tap
/// should not claim all of them.
public struct CardioShadow: Codable, Sendable, Equatable {
    public var durationMinutes: String?
    public var distance: String?
    public var elevationGain: String?
    public var avgHeartRate: String?

    public init(durationMinutes: String? = nil, distance: String? = nil, elevationGain: String? = nil, avgHeartRate: String? = nil) {
        self.durationMinutes = durationMinutes
        self.distance = distance
        self.elevationGain = elevationGain
        self.avgHeartRate = avgHeartRate
    }
}

public struct CardioLog: Codable, Sendable, Equatable {
    public var durationMinutes: String?
    public var distance: String?
    public var elevationGain: String?
    public var avgHeartRate: String?
    public var isLogged: Bool
    public var shadow: CardioShadow?

    public init(
        durationMinutes: String? = "", distance: String? = "", elevationGain: String? = "", avgHeartRate: String? = "",
        isLogged: Bool = false, shadow: CardioShadow? = nil
    ) {
        self.durationMinutes = durationMinutes
        self.distance = distance
        self.elevationGain = elevationGain
        self.avgHeartRate = avgHeartRate
        self.isLogged = isLogged
        self.shadow = shadow
    }
}

/// Detected server-side at finish time (W3) — Swift never computes a PR.
public struct PersonalRecord: Codable, Sendable, Equatable {
    public let kind: String
    public let exerciseName: String
    public let estimatedOneRM: Double?
    public let weight: Double?
    public let reps: Int?
    public let previousOneRM: Double?
    public let previousDate: String?
    public let description: String

    public init(
        kind: String, exerciseName: String, estimatedOneRM: Double? = nil, weight: Double? = nil, reps: Int? = nil,
        previousOneRM: Double? = nil, previousDate: String? = nil, description: String
    ) {
        self.kind = kind
        self.exerciseName = exerciseName
        self.estimatedOneRM = estimatedOneRM
        self.weight = weight
        self.reps = reps
        self.previousOneRM = previousOneRM
        self.previousDate = previousDate
        self.description = description
    }
}

public struct ScoreRecord: Codable, Sendable, Equatable {
    public let kind: String?
    public let description: String?

    public init(kind: String? = nil, description: String? = nil) {
        self.kind = kind
        self.description = description
    }
}

/// `POST /api/workout-sessions { action: "finish" }` (W3).
public struct FinishResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let totalDurationSeconds: Int?
    public let prs: [PersonalRecord]
    public let scoreRecord: ScoreRecord?
    /// Plain-text recap the coach summarises from; shown while the summary streams.
    public let recap: String?

    public init(ok: Bool, totalDurationSeconds: Int? = nil, prs: [PersonalRecord] = [], scoreRecord: ScoreRecord? = nil, recap: String? = nil) {
        self.ok = ok
        self.totalDurationSeconds = totalDurationSeconds
        self.prs = prs
        self.scoreRecord = scoreRecord
        self.recap = recap
    }
}
