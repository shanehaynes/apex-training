import Foundation

/// The seven types `src/utils/workoutColors.ts` defines, plus a fallback.
///
/// `unknown` is load-bearing: the server can add a type before the app ships an
/// update, and an unknown string must render as a plain event rather than fail
/// the whole schedule decode.
public enum WorkoutType: RawRepresentable, Codable, Hashable, Sendable {
    case stretching
    case morningRoutine
    case weights
    case climbing
    case outdoorClimbing
    case cardio
    case yoga
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "stretching": self = .stretching
        case "morning-routine": self = .morningRoutine
        case "weights": self = .weights
        case "climbing": self = .climbing
        case "outdoor-climbing": self = .outdoorClimbing
        case "cardio": self = .cardio
        case "yoga": self = .yoga
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .stretching: "stretching"
        case .morningRoutine: "morning-routine"
        case .weights: "weights"
        case .climbing: "climbing"
        case .outdoorClimbing: "outdoor-climbing"
        case .cardio: "cardio"
        case .yoga: "yoga"
        case .unknown(let raw): raw
        }
    }

    public static let known: [WorkoutType] = [
        .stretching, .morningRoutine, .weights, .climbing, .outdoorClimbing, .cardio, .yoga,
    ]
}
