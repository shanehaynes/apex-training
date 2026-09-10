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
/// server adds later never fails the whole schedule decode. Fields are `var`
/// (the `Exercise.name` precedent) so an optimistic edit is `var copy = base;
/// copy.title = …` — the index itself stays a value that is rebuilt, never
/// mutated in place.
public struct WorkoutEventBase: Codable, Sendable, Equatable {
    public var id: String
    public var type: WorkoutType
    public var sport: String?
    public var title: String
    public var subtitle: String?
    /// The server builds each base from the first in-window occurrence, so
    /// this is NOT the series anchor. Never place an event by it — place by
    /// `Occurrence.date`.
    public var date: String
    public var startTime: String?
    public var endTime: String?
    public var estimatedDuration: Int?
    public var description: String?
    public var warmup: [Exercise]?
    public var exercises: [Exercise]?
    public var cooldown: [Exercise]?
    public var difficulty: Int?
    public var location: String?
    public var coverImageUrl: String?
    public var cardioTargets: CardioTargets?
    public var climbingTargets: ClimbingTargets?
    public var tags: [String]?
    public var equipment: [String]?
    public var source: String?
    public var templateId: String?
    public var scoringType: String?
    public var timeCapMinutes: Int?
    public var isCompleted: Bool?
    public var completedAt: String?
    public var isRecurring: Bool?
    public var recurrenceRule: String?
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
    public var id: String
    public var baseId: String
    public var date: String
    /// The date this occurrence was generated at — what `/api/event-instances`
    /// keys a skip, move or detach on. Differs from `date` once an override
    /// moved the occurrence; for the series anchor (bare id) it is the base
    /// row's own date, which nothing else carries. Optional: a window cached
    /// by a build before W7 lacks it, and `ScheduleEvent.keyDate` falls back.
    public var originalDate: String?
    public var startTime: String?
    public var endTime: String?
    public var isCompleted: Bool
    /// A timestamp string, never a `Date` — see FixtureContractTests.
    public var completedAt: String?

    public init(
        id: String, baseId: String, date: String, originalDate: String? = nil,
        startTime: String? = nil, endTime: String? = nil, isCompleted: Bool = false, completedAt: String? = nil
    ) {
        self.id = id
        self.baseId = baseId
        self.date = date
        self.originalDate = originalDate
        self.startTime = startTime
        self.endTime = endTime
        self.isCompleted = isCompleted
        self.completedAt = completedAt
    }
}

public struct Exercise: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// `name` and `definitionId` are `var`: a tracker swap relabels the logged
    /// rows onto another definition (`TrackerEditor.swap`). The id never moves.
    public var name: String
    public var category: String?
    public var sets: Int?
    public var reps: String?
    public var weight: String?
    public var duration: String?
    public var restPeriod: String?
    /// Per-set ramp targets; cleared when a prescription field is edited
    /// (`EventExerciseEditor` rule) because they no longer describe it.
    public var plannedSets: [PlannedSet]?
    /// Superset/circuit label ("A", "B"): consecutive entries in one section
    /// sharing a label are performed together. `var` for the editor:
    /// `Supersets` (the `src/lib/schedule/supersets.ts` port) re-letters as
    /// the user drags, and the server re-letters again on every write.
    public var superset: String?
    /// Climbing pitches only.
    public var climbStyle: String?
    public var grade: String?
    public var ascentStyle: String?
    public var definitionId: String?
    public let muscleGroups: [String]?
    public var notes: String?
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

/// A workout-library entry (`rowToTemplate` in `src/lib/schedule/templates.ts`):
/// an event minus its calendar placement, plus scoring. Applying one is the
/// builder's job (W7); archive/restore lives under Library (W10).
public struct WorkoutTemplate: Codable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let type: WorkoutType
    public let sport: String?
    public let scoringType: String?
    public let timeCapMinutes: Int?
    public let estimatedDuration: Int?
    public let difficulty: Int?
    public let description: String?
    public let warmup: [Exercise]?
    public let exercises: [Exercise]?
    public let cooldown: [Exercise]?
    public let location: String?
    public let tags: [String]?
    public let equipment: [String]?
    public let cardioTargets: CardioTargets?
    public let climbingTargets: ClimbingTargets?
    public let archivedAt: String?
    /// Server-stamped on every save; the library list sorts by it.
    public let updatedAt: String?

    public init(
        id: String, title: String, type: WorkoutType, sport: String? = nil, scoringType: String? = nil,
        timeCapMinutes: Int? = nil, estimatedDuration: Int? = nil, difficulty: Int? = nil, description: String? = nil,
        warmup: [Exercise]? = nil, exercises: [Exercise]? = nil, cooldown: [Exercise]? = nil, location: String? = nil,
        tags: [String]? = nil, equipment: [String]? = nil, cardioTargets: CardioTargets? = nil,
        climbingTargets: ClimbingTargets? = nil, archivedAt: String? = nil, updatedAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.type = type
        self.sport = sport
        self.scoringType = scoringType
        self.timeCapMinutes = timeCapMinutes
        self.estimatedDuration = estimatedDuration
        self.difficulty = difficulty
        self.description = description
        self.warmup = warmup
        self.exercises = exercises
        self.cooldown = cooldown
        self.location = location
        self.tags = tags
        self.equipment = equipment
        self.cardioTargets = cardioTargets
        self.climbingTargets = climbingTargets
        self.archivedAt = archivedAt
        self.updatedAt = updatedAt
    }
}
