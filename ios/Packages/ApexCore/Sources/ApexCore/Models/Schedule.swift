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
public struct WorkoutEventBase: Codable, Sendable, Equatable {
    public let id: String
    public let type: WorkoutType
    public let title: String
    public let date: String
    public let startTime: String?
    public let endTime: String?
    public let estimatedDuration: Int?
    public let description: String?
    public let warmup: [Exercise]?
    public let exercises: [Exercise]?
    public let cooldown: [Exercise]?
    public let difficulty: Int?
    public let tags: [String]?
    public let equipment: [String]?
    public let isCompleted: Bool?
    public let isRecurring: Bool?
    public let recurrenceRule: String?
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
    public let definitionId: String?
    public let muscleGroups: [String]?
    public let notes: String?
}

public struct ExerciseDefinition: Codable, Sendable, Equatable {
    public let id: String
    public let canonicalName: String
    public let aliases: [String]?
    public let category: String?
    public let muscleGroups: [String]?
    public let equipment: [String]?
    public let isUnilateral: Bool?
}

public struct WorkoutTemplate: Codable, Sendable, Equatable {
    public let id: String
    public let name: String?
    public let type: WorkoutType?
}
