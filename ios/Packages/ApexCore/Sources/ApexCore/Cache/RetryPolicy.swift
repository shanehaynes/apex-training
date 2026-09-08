import Foundation

/// What a failed flush means for the op (architecture.md §7): network, 5xx and
/// 429 are transient and retry with backoff; a 401 means the client's own
/// refresh-once already ran, so the queue pauses until something external
/// (network back, foreground, sign-in) says try again; every other 4xx is
/// permanent — the op is kept and shown, never dropped.
public struct RetryPolicy: Sendable, Equatable {
    public enum Verdict: Sendable, Equatable {
        case retry(after: Double)
        case pause
        case fail(String)
    }

    public var baseDelay: Double
    public var maxDelay: Double

    public init(baseDelay: Double = 1, maxDelay: Double = 300) {
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
    }

    public static let `default` = RetryPolicy()

    /// `attempts` is how many times the op has already failed: 1s, 2s, 4s, …
    /// capped. No jitter — one phone, one queue, and deterministic tests.
    public func backoff(attempts: Int) -> Double {
        min(maxDelay, baseDelay * pow(2, Double(max(0, attempts))))
    }

    public func classify(_ error: APIError, attempts: Int) -> Verdict {
        switch error {
        case .network:
            return .retry(after: backoff(attempts: attempts))
        case .server(let status, _) where (500...599).contains(status):
            return .retry(after: backoff(attempts: attempts))
        case .rateLimited(let retryAfter):
            return .retry(after: retryAfter ?? backoff(attempts: attempts))
        case .unauthorized:
            return .pause
        case .server(_, let message):
            return .fail(message ?? error.description)
        case .missingAnthropicKey, .termsAcceptanceRequired, .payloadTooLarge, .decoding:
            return .fail(error.description)
        }
    }

    /// The handler's 400 for a `startedAt` / `finishedAt` outside its window
    /// (`clientTimestamp` in api/_lib/handlers/workoutSessions.ts).
    public static func isTimestampWindowRejection(_ error: APIError) -> Bool {
        guard case .server(let status, let message) = error, status == 400, let message else { return false }
        return message.contains("within the last 7 days")
    }
}
