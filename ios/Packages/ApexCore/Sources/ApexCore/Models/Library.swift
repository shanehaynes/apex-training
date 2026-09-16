import Foundation

/// `POST /api/query { tool: "search_exercises" }` — `api/_lib/mcp/tools/library.ts`.
/// Since W10 each entry carries the definition `id` and, on request, the
/// number of planned workouts it appears in (`references`) — the web
/// library's "in N workouts", counted server-side because the phone holds
/// only a window of the schedule. The definitions themselves (with defaults
/// and archive state) still come cached from `/api/schedule?include=`; this
/// call decorates that list with the stats the rows show.
public struct SearchExercisesResult: Codable, Sendable, Equatable {
    public let query: String?
    public let totalMatches: Int
    public let exercises: [Entry]

    public struct Prescription: Codable, Sendable, Equatable {
        public let sets: Int?
        public let reps: String?
        public let duration: String?
        public let weight: String?
        public let rest: String?
    }

    public struct Entry: Codable, Sendable, Equatable {
        /// Absent from a response older than W10.
        public let id: String?
        public let canonicalName: String
        public let category: String?
        public let aliases: [String]?
        public let muscleGroups: [String]?
        public let equipment: [String]?
        public let isUnilateral: Bool?
        public let defaultPrescription: Prescription?
        public let techniqueNotes: String?
        public let lastPerformed: String?
        public let archived: Bool?
        /// Only when the call asked for `include_references`.
        public let references: Int?

        enum CodingKeys: String, CodingKey {
            case id, category, aliases, equipment, archived, references
            case canonicalName = "canonical_name"
            case muscleGroups = "muscle_groups"
            case isUnilateral = "is_unilateral"
            case defaultPrescription = "default_prescription"
            case techniqueNotes = "technique_notes"
            case lastPerformed = "last_performed"
        }
    }

    enum CodingKeys: String, CodingKey {
        case query
        case totalMatches = "total_matches"
        case exercises
    }

    /// The library's decoration read: everything, archived included, with
    /// the reference counts. The ceiling is the server's.
    public static func args(query: String = "", includeArchived: Bool = true, includeReferences: Bool = true, limit: Int = 500) -> [String: JSONValue] {
        [
            "query": .string(query),
            "include_archived": .bool(includeArchived),
            "include_references": .bool(includeReferences),
            "limit": .number(Double(limit)),
        ]
    }
}

/// `POST /api/query { tool: "get_exercise_history" }` — `api/_lib/mcp/tools/tracking.ts`.
/// Alias-aware: a former name resolves to the current one and `resolvedFrom`
/// says so. An exercise with no logged history is a 400, not an empty result.
public struct ExerciseHistoryResult: Codable, Sendable, Equatable {
    public struct Best: Codable, Sendable, Equatable {
        public let display: String
        public let date: String
    }

    public struct TrendPoint: Codable, Sendable, Equatable {
        public let date: String
        public let value: Double
    }

    public struct Session: Codable, Sendable, Equatable {
        public let date: String
        /// Logged sets in order, e.g. "185 × 5" or "0:45".
        public let sets: [String]
    }

    public let canonicalName: String
    public let resolvedFrom: String?
    /// `oneRM`, `duration`, `reps`, `distance`, or nil when nothing parsed.
    public let statKind: String?
    /// The axis and PR label: "est. 1RM", "hold", "reps", or the cardio unit.
    public let statUnit: String
    public let allTimeBest: Best?
    public let totalSessions: Int
    public let trend: [TrendPoint]
    public let recentSessions: [Session]

    enum CodingKeys: String, CodingKey {
        case trend
        case canonicalName = "canonical_name"
        case resolvedFrom = "resolved_from"
        case statKind = "stat_kind"
        case statUnit = "stat_unit"
        case allTimeBest = "all_time_best"
        case totalSessions = "total_sessions"
        case recentSessions = "recent_sessions"
    }

    public static func args(exerciseName: String, limit: Int = 10) -> [String: JSONValue] {
        ["exercise_name": .string(exerciseName), "limit": .number(Double(limit))]
    }
}
