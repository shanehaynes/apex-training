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
    public let name: String
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
    public let definitionId: String?
    public let muscleGroups: [String]?
    public let notes: String?
    public let imageUrl: String?
    public let techniqueNotes: String?
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
}

public struct WorkoutTemplate: Codable, Sendable, Equatable {
    public let id: String
    public let name: String?
    public let type: WorkoutType?
}
