import Foundation

/// One tracker session: an occurrence on a date. Every queued op and every log
/// row is scoped by the pair — the server keys `workout_sessions` on it.
public struct SessionKey: Hashable, Codable, Sendable {
    public let eventId: String
    public let eventDate: String

    public init(eventId: String, eventDate: String) {
        self.eventId = eventId
        self.eventDate = eventDate
    }
}

/// Identifies one set the way the web's dirty-key string does
/// (`${section}|${exerciseId}|${setNumber}` in useWorkoutSession.ts). Also the
/// `removedSets` entry shape the server reads (`section`, `exerciseId`, `setNumber`).
public struct SetKey: Hashable, Codable, Sendable {
    public let section: String
    public let exerciseId: String
    public let setNumber: Int

    public init(section: String, exerciseId: String, setNumber: Int) {
        self.section = section
        self.exerciseId = exerciseId
        self.setNumber = setNumber
    }

    public var string: String { "\(section)|\(exerciseId)|\(setNumber)" }
    public var exerciseKey: CardioKey { CardioKey(section: section, exerciseId: exerciseId) }
}

/// One exercise within a session — the cardio dirty key (`${section}|${exerciseId}`).
public struct CardioKey: Hashable, Codable, Sendable {
    public let section: String
    public let exerciseId: String

    public init(section: String, exerciseId: String) {
        self.section = section
        self.exerciseId = exerciseId
    }

    public var string: String { "\(section)|\(exerciseId)" }
}

/// The three actual columns of a set row, in the web's fixed display order
/// (weight → reps → time, `FIELD_ORDER` in TrackerExercise.tsx).
public enum SetField: String, CaseIterable, Codable, Sendable {
    case weight = "actualWeight"
    case reps = "actualReps"
    case duration = "actualDuration"
}

public enum CardioField: String, CaseIterable, Codable, Sendable {
    case durationMinutes
    case distance
    case elevationGain
    case avgHeartRate
}

/// One focusable input on the tracker screen. Lives here so the Next/Done
/// walk (`TrackerEditor.fieldOrder`) is testable without a view.
public enum FieldID: Hashable, Sendable {
    case set(SetKey, SetField)
    case cardio(CardioKey, CardioField)
}

extension TrackedSet {
    public subscript(field: SetField) -> String {
        get {
            switch field {
            case .weight: actualWeight ?? ""
            case .reps: actualReps ?? ""
            case .duration: actualDuration ?? ""
            }
        }
        set {
            switch field {
            case .weight: actualWeight = newValue
            case .reps: actualReps = newValue
            case .duration: actualDuration = newValue
            }
        }
    }

    /// Any actual typed or saved — the web's `set.actualWeight || set.actualReps || set.actualDuration`.
    public var hasAnyActual: Bool { SetField.allCases.contains { !self[$0].isEmpty } }
}

extension ShadowValues {
    public subscript(field: SetField) -> String {
        switch field {
        case .weight: weight ?? ""
        case .reps: reps ?? ""
        case .duration: duration ?? ""
        }
    }
}

extension CardioLog {
    public subscript(field: CardioField) -> String {
        get {
            switch field {
            case .durationMinutes: durationMinutes ?? ""
            case .distance: distance ?? ""
            case .elevationGain: elevationGain ?? ""
            case .avgHeartRate: avgHeartRate ?? ""
            }
        }
        set {
            switch field {
            case .durationMinutes: durationMinutes = newValue
            case .distance: distance = newValue
            case .elevationGain: elevationGain = newValue
            case .avgHeartRate: avgHeartRate = newValue
            }
        }
    }
}

extension CardioShadow {
    public subscript(field: CardioField) -> String {
        get {
            switch field {
            case .durationMinutes: durationMinutes ?? ""
            case .distance: distance ?? ""
            case .elevationGain: elevationGain ?? ""
            case .avgHeartRate: avgHeartRate ?? ""
            }
        }
        set {
            switch field {
            case .durationMinutes: durationMinutes = newValue
            case .distance: distance = newValue
            case .elevationGain: elevationGain = newValue
            case .avgHeartRate: avgHeartRate = newValue
            }
        }
    }
}
