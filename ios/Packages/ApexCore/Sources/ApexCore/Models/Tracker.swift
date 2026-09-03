import Foundation

/// `GET /api/workout-sessions/bootstrap` (W3) — everything the tracker needs to
/// open, already grouped by the server.
///
/// Note the casing split: `session` is a raw DB row and is snake_case, while
/// `event` and `groups` are API shapes and are camelCase. That is why these
/// models declare `CodingKeys` explicitly instead of relying on a
/// `.convertFromSnakeCase` decoder — one global strategy cannot serve both.
public struct TrackerBootstrap: Codable, Sendable, Equatable {
    public let session: Session?
    public let event: WorkoutEventBase?
    public let groups: [TrackedSectionGroup]
    public let scored: Bool
    public let prs: [PersonalRecord]?
    public let scoreRecord: ScoreRecord?

    public struct Session: Codable, Sendable, Equatable {
        public let id: String
        public let userId: String
        public let eventId: String
        public let eventDate: String
        public let startedAt: String?
        public let finishedAt: String?
        public let updatedAt: String?
        public let totalDurationSeconds: Int?
        public let coachSummary: String?
        public let templateId: String?
        public let scoreType: String?
        public let scoreTimeSeconds: Int?
        public let scoreRounds: Int?
        public let scoreReps: Int?

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
    public let exercises: [TrackedExercise]
}

public struct TrackedExercise: Codable, Sendable, Equatable {
    public let section: String
    public let exercise: Exercise
    public let substitutedFrom: String?
    public let isCardio: Bool
    public let sets: [TrackedSet]
    public let cardio: CardioLog?
}

public struct TrackedSet: Codable, Sendable, Equatable {
    public let setNumber: Int
    public let planned: PlannedSet?
    public let actualWeight: String?
    public let actualReps: String?
    public let actualDuration: String?
    public let isLogged: Bool
    public let isAutofilled: Bool
    public let isExtra: Bool
    /// The greyed-out suggestion the web calls a shadow. It commits on tap, never
    /// on its own.
    public let shadow: ShadowValues?
}

public struct PlannedSet: Codable, Sendable, Equatable {
    public let setNumber: Int
    public let targetWeight: String?
    public let targetReps: String?
    public let targetDuration: String?
}

public struct ShadowValues: Codable, Sendable, Equatable {
    public let weight: String?
    public let reps: String?
    public let duration: String?
}

public struct CardioLog: Codable, Sendable, Equatable {
    public let durationMinutes: String?
    public let distance: String?
    public let elevationGain: String?
    public let avgHeartRate: String?
    public let isLogged: Bool
    public let shadow: ShadowValues?
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
}

public struct ScoreRecord: Codable, Sendable, Equatable {
    public let kind: String?
    public let description: String?
}

/// `POST /api/workout-sessions/finish` (W3).
public struct FinishResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let totalDurationSeconds: Int?
    public let prs: [PersonalRecord]
    public let scoreRecord: ScoreRecord?
    /// Plain-text recap the coach summarises from; shown while the summary streams.
    public let recap: String?
}
