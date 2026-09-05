import Foundation

/// A workout-level score for a scored template (`SessionScore` in
/// src/lib/tracking/records.ts). The PR comparison stays on the server; Swift
/// only collects, formats and round-trips the value.
public enum SessionScore: Equatable, Sendable, Codable {
    case forTime(timeSeconds: Int)
    case amrap(rounds: Int, reps: Int)

    public var type: String {
        switch self {
        case .forTime: "for-time"
        case .amrap: "amrap"
        }
    }

    /// `sessionScoreFromRow`: the score a session row carries, if any.
    public init?(scoreType: String?, timeSeconds: Int?, rounds: Int?, reps: Int?) {
        switch scoreType {
        case "for-time":
            guard let timeSeconds, timeSeconds > 0 else { return nil }
            self = .forTime(timeSeconds: timeSeconds)
        case "amrap":
            guard let rounds else { return nil }
            self = .amrap(rounds: rounds, reps: reps ?? 0)
        default:
            return nil
        }
    }

    public init?(session: TrackerBootstrap.Session) {
        self.init(
            scoreType: session.scoreType, timeSeconds: session.scoreTimeSeconds,
            rounds: session.scoreRounds, reps: session.scoreReps
        )
    }

    /// `formatScore`: "41:32" for time, "18 rounds + 7" for AMRAP.
    public var formatted: String {
        switch self {
        case .forTime(let seconds): DurationBuffer.formatClock(seconds)
        case .amrap(let rounds, let reps): reps > 0 ? "\(rounds) rounds + \(reps)" : "\(rounds) rounds"
        }
    }

    private enum CodingKeys: String, CodingKey { case type, timeSeconds, rounds, reps }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case .forTime(let timeSeconds):
            try c.encode(timeSeconds, forKey: .timeSeconds)
        case .amrap(let rounds, let reps):
            try c.encode(rounds, forKey: .rounds)
            try c.encode(reps, forKey: .reps)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let score = SessionScore(
            scoreType: try c.decode(String.self, forKey: .type),
            timeSeconds: try c.decodeIfPresent(Int.self, forKey: .timeSeconds),
            rounds: try c.decodeIfPresent(Int.self, forKey: .rounds),
            reps: try c.decodeIfPresent(Int.self, forKey: .reps)
        ) else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "not a session score")
        }
        self = score
    }
}
