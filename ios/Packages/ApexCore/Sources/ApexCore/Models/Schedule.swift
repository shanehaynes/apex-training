import Foundation

/// `GET /api/schedule` — one window, expanded server-side. There is no local
/// RRULE expansion by design (D-008): the window *is* the cache.
public struct ScheduleResponse: Codable, Sendable, Equatable {
    public let window: Window
    public let bases: [WorkoutEventBase]
    public let occurrences: [Occurrence]
    public let definitions: [ExerciseDefinition]?
    public let templates: [WorkoutTemplate]?

    public struct Window: Codable, Sendable, Equatable {
        /// `YYYY-MM-DD`.
        public let start: String
        public let end: String
    }
}

/// A stored event row. Recurring events have one base and many occurrences.
///
/// Field set follows `WorkoutEvent` in `src/types/workout.ts`. Enum-like
/// strings (`sport`, `source`, `scoringType`) stay `String?` so a value the
/// server adds later never fails the whole schedule decode.
public struct WorkoutEventBase: Codable, Sendable, Equatable {
    public let id: String
    public let type: WorkoutType
    public let sport: String?
    public let title: String
    public let subtitle: String?
    /// The server builds each base from the first in-window occurrence, so
    /// this is NOT the series anchor. Never place an event by it — place by
    /// `Occurrence.date`.
    public let date: String
    public let startTime: String?
    public let endTime: String?
    public let estimatedDuration: Int?
    public let description: String?
    public let warmup: [Exercise]?
    public let exercises: [Exercise]?
    public let cooldown: [Exercise]?
    public let difficulty: Int?
    public let location: String?
    public let coverImageUrl: String?
    public let cardioTargets: CardioTargets?
    public let climbingTargets: ClimbingTargets?
    public let tags: [String]?
    public let equipment: [String]?
    public let source: String?
    public let templateId: String?
    public let scoringType: String?
    public let timeCapMinutes: Int?
    public let isCompleted: Bool?
    public let completedAt: String?
    public let isRecurring: Bool?
    public let recurrenceRule: String?
}

/// Planned session targets for a cardio event. Free-text distance/elevation
/// match the tracker's cardio log fields ("5 mi", "800 ft"); heart rate is bpm.
public struct CardioTargets: Codable, Sendable, Equatable {
    public let distance: String?
    public let elevationGain: String?
    public let avgHeartRate: Double?
}

/// Planned session targets for an outdoor climbing event. Fields the web
/// derives from the pitch list (`src/lib/climbing.ts`, tested) are shown only
/// when stored — Swift never derives them.
public struct ClimbingTargets: Codable, Sendable, Equatable {
    public let maxGrade: String?
    public let totalPitches: Int?
}


/// One dated instance of a base. `id` is the `OccurrenceID` — `baseId` for the
/// first, `baseId__YYYY-MM-DD` for the rest.
public struct Occurrence: Codable, Sendable, Equatable {
    public let id: String
    public let baseId: String
    public let date: String
    public let startTime: String?
    public let endTime: String?
    public let isCompleted: Bool
    /// A timestamp string, never a `Date` — see FixtureContractTests.
    public let completedAt: String?
}

public struct Exercise: Codable, Sendable, Equatable {
    public let id: String
    /// `name` and `definitionId` are `var`: a tracker swap relabels the logged
    /// rows onto another definition (`TrackerEditor.swap`). The id never moves.
    public var name: String
    public let category: String?
    public let sets: Int?
    public let reps: String?
    public let weight: String?
    public let duration: String?
    public let restPeriod: String?
    public let plannedSets: [PlannedSet]?
    /// Superset/circuit label ("A", "B"): consecutive entries in one section
    /// sharing a label are performed together. Adjacency is maintained server
    /// side (`src/lib/schedule/supersets.ts`); the client only groups for display.
    public let superset: String?
    /// Climbing pitches only.
    public let climbStyle: String?
    public let grade: String?
    public let ascentStyle: String?
    public var definitionId: String?
    public let muscleGroups: [String]?
    public let notes: String?
    public let imageUrl: String?
    public let techniqueNotes: String?

    public init(
        id: String, name: String, category: String? = nil, sets: Int? = nil, reps: String? = nil,
        weight: String? = nil, duration: String? = nil, restPeriod: String? = nil, plannedSets: [PlannedSet]? = nil,
        superset: String? = nil, climbStyle: String? = nil, grade: String? = nil, ascentStyle: String? = nil,
        definitionId: String? = nil, muscleGroups: [String]? = nil, notes: String? = nil,
        imageUrl: String? = nil, techniqueNotes: String? = nil
    ) {
        self.id = id
        self.name = name
        self.category = category
        self.sets = sets
        self.reps = reps
        self.weight = weight
        self.duration = duration
        self.restPeriod = restPeriod
        self.plannedSets = plannedSets
        self.superset = superset
        self.climbStyle = climbStyle
        self.grade = grade
        self.ascentStyle = ascentStyle
        self.definitionId = definitionId
        self.muscleGroups = muscleGroups
        self.notes = notes
        self.imageUrl = imageUrl
        self.techniqueNotes = techniqueNotes
    }
}

public struct ExerciseDefinition: Codable, Sendable, Equatable {
    public let id: String
    public let canonicalName: String
    public let aliases: [String]?
    public let category: String?
    public let muscleGroups: [String]?
    public let equipment: [String]?
    public let imageUrl: String?
    public let techniqueNotes: String?
    public let isUnilateral: Bool?
    /// The default prescription (`rowToDefinition` in src/lib/schedule/definitions.ts).
    /// The tracker's swap picker reads these to decide which inputs a
    /// swapped-in movement gets; the server omits them when null.
    public let defaultSets: Int?
    public let defaultReps: String?
    public let defaultDuration: String?
    public let defaultWeight: String?
    public let defaultRest: String?
    /// Set once archived; the swap picker hides archived movements.
    public let archivedAt: String?

    public init(
        id: String, canonicalName: String, aliases: [String]? = nil, category: String? = nil,
        muscleGroups: [String]? = nil, equipment: [String]? = nil, imageUrl: String? = nil,
        techniqueNotes: String? = nil, isUnilateral: Bool? = nil, defaultSets: Int? = nil,
        defaultReps: String? = nil, defaultDuration: String? = nil, defaultWeight: String? = nil,
        defaultRest: String? = nil, archivedAt: String? = nil
    ) {
        self.id = id
        self.canonicalName = canonicalName
        self.aliases = aliases
        self.category = category
        self.muscleGroups = muscleGroups
        self.equipment = equipment
        self.imageUrl = imageUrl
        self.techniqueNotes = techniqueNotes
        self.isUnilateral = isUnilateral
        self.defaultSets = defaultSets
        self.defaultReps = defaultReps
        self.defaultDuration = defaultDuration
        self.defaultWeight = defaultWeight
        self.defaultRest = defaultRest
        self.archivedAt = archivedAt
    }
}

public struct WorkoutTemplate: Codable, Sendable, Equatable {
    public let id: String
    public let name: String?
    public let type: WorkoutType?
}
