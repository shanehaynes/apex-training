import Foundation

/// The Apple Health activity a finished workout is filed under (W16, D-056).
/// A mirror of the `HKWorkoutActivityType` cases Apex uses, so the mapping is
/// decided — and proved by `swift test` on Linux — here; `ApexHealth` turns a
/// case into the HealthKit value and nothing more.
public enum HealthActivityKind: String, Sendable, Equatable, CaseIterable {
    case traditionalStrengthTraining
    case functionalStrengthTraining
    case climbing
    case running
    case cycling
    case swimming
    case mixedCardio
    case yoga
    case flexibility
    case other

    /// From the event's type and sport (phase37: running · biking · swimming ·
    /// climbing · other) and whether the main work holds a cardio movement.
    /// A strength session with a row or a run in its main work is filed as
    /// functional strength; a cardio warm-up or cool-down does not count.
    public static func forWorkout(type: WorkoutType, sport: String?, hasMainCardio: Bool) -> HealthActivityKind {
        switch type {
        case .weights: return hasMainCardio ? .functionalStrengthTraining : .traditionalStrengthTraining
        case .climbing, .outdoorClimbing: return .climbing
        case .cardio:
            switch sport {
            case "running": return .running
            case "biking": return .cycling
            case "swimming": return .swimming
            case "climbing": return .climbing
            default: return .mixedCardio
            }
        case .yoga: return .yoga
        case .stretching, .morningRoutine: return .flexibility
        case .unknown: return .other
        }
    }
}

/// One finished tracker session as Apple Health will store it: an Apex-branded
/// workout with the session's real start and end. Built from the tracker's
/// local state at finish time, so it never waits on the network (D-056).
///
/// `syncIdentifier` + `syncVersion` are what make a second save of the same
/// occurrence replace the first instead of adding a duplicate, and what a
/// cancel deletes by.
public struct HealthWorkoutDraft: Sendable, Equatable {
    public let session: SessionKey
    public let kind: HealthActivityKind
    public let title: String
    public let start: Date
    public let end: Date

    /// Nil when there is nothing true to write: no start (a quick-complete, or
    /// a session the tracker never saw begin) or an end not after the start.
    public init?(session: SessionKey, kind: HealthActivityKind, title: String, startedAt: Date?, finishedAt: Date) {
        guard let startedAt, finishedAt > startedAt else { return nil }
        self.session = session
        self.kind = kind
        self.title = title
        self.start = startedAt
        self.end = finishedAt
    }

    /// The tracker's finish: the occurrence, its logged groups, and the two
    /// instants the model holds.
    public init?(event: ScheduleEvent, groups: [TrackedSectionGroup], startedAt: Date?, finishedAt: Date) {
        let hasMainCardio = groups.contains { $0.section == "exercise" && $0.exercises.contains(where: \.isCardio) }
        self.init(
            session: SessionKey(eventId: event.id, eventDate: event.date),
            kind: .forWorkout(type: event.base.type, sport: event.base.sport, hasMainCardio: hasMainCardio),
            title: event.title, startedAt: startedAt, finishedAt: finishedAt
        )
    }

    public var syncIdentifier: String { Self.syncIdentifier(for: session) }

    /// Whole seconds of the finish: a later finish of the same occurrence
    /// (cancelled, then tracked again) always carries a higher version.
    public var syncVersion: Int { Int(end.timeIntervalSince1970) }

    public static func syncIdentifier(for session: SessionKey) -> String {
        "apex:\(session.eventId)|\(session.eventDate)"
    }
}
