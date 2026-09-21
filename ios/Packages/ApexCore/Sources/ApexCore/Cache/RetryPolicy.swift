import Foundation

/// What a failed flush means for the op (architecture.md §7): network, 5xx and
/// 429 are transient and retry with backoff *up to a ceiling*; a 401 means the
/// client's own refresh-once already ran, so the queue pauses until something
/// external (network back, foreground, sign-in) says try again; every other 4xx
/// is permanent — the op is kept and shown, never dropped.
public struct RetryPolicy: Sendable, Equatable {
    public enum Verdict: Sendable, Equatable {
        case retry(after: Double)
        case pause
        case fail(String)
    }

    public var baseDelay: Double
    public var maxDelay: Double
    /// How many times an op may fail transiently before the verdict becomes
    /// permanent. A 5xx is not always transient — every Postgres error on the
    /// queue path is a 500, and a missing env var or a migration lagging the
    /// code 500s forever — and `WriteQueue` is strict FIFO per session, so an
    /// unbounded retry blocks the `finish` behind it and the user sees
    /// "N sets pending sync" for days. Eight attempts is ~20–60 minutes of
    /// backoff; past that the op fails, which keeps it, shows it on the
    /// Retry/Discard bar and lets the rest of the session drain past it.
    public var maxAttempts: Int

    public init(baseDelay: Double = 1, maxDelay: Double = 300, maxAttempts: Int = 8) {
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
        self.maxAttempts = maxAttempts
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
            return transient(error, attempts: attempts, after: backoff(attempts: attempts))
        case .server(let status, _) where (500...599).contains(status):
            return transient(error, attempts: attempts, after: backoff(attempts: attempts))
        case .rateLimited(let retryAfter):
            return transient(error, attempts: attempts, after: retryAfter ?? backoff(attempts: attempts))
        case .unauthorized:
            return .pause
        case .server(_, let message):
            return .fail(message ?? error.description)
        case .missingAnthropicKey, .termsAcceptanceRequired, .payloadTooLarge, .decoding:
            return .fail(error.description)
        }
    }

    /// The retry ceiling. `attempts` is how many times the op had already
    /// failed *before* this one, so `attempts >= maxAttempts` means this
    /// failure is number `maxAttempts + 1` and the op stops retrying. The op is
    /// not dropped: `WriteQueue` marks it `failed`, and Retry on the tracker
    /// bar puts it back on `attempts == 0` with the full ladder again.
    private func transient(_ error: APIError, attempts: Int, after delay: Double) -> Verdict {
        guard attempts >= maxAttempts else { return .retry(after: delay) }
        return .fail(Self.gaveUpMessage(error, attempts: attempts))
    }

    /// What the tracker's failure bar shows for an op that ran out of retries.
    public static func gaveUpMessage(_ error: APIError, attempts: Int) -> String {
        "Could not sync after \(attempts + 1) attempts. \(error.description)"
    }

    /// The handler's 400 for a `startedAt` / `finishedAt` outside its window
    /// (`clientTimestamp` in api/_lib/handlers/workoutSessions.ts).
    public static func isTimestampWindowRejection(_ error: APIError) -> Bool {
        guard case .server(let status, let message) = error, status == 400, let message else { return false }
        return message.contains("within the last 7 days")
    }
}
