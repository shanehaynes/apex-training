import Foundation

/// The tracker's write queue (architecture.md §7, D-003): every tracker write
/// is an op that survives a relaunch and flushes in order per session.

public enum TrackerAction: String, Codable, Sendable {
    case start, save, finish, cancel, completion
    case swapExercise = "swap-exercise"
}

/// Typed, not opaque JSON: merging two saves and counting pending sets both
/// need to see inside a payload.
public enum TrackerOpPayload: Codable, Sendable, Equatable {
    /// When the session really began (ISO, `CompletionRows.isoTimestamp`). Nil
    /// after the server refused a stamp outside its window — it then stamps now.
    case start(startedAt: String?)
    case save(SavePayload)
    case finish(FinishPayload)
    case cancel
    case swapExercise(SwapPayload)
    /// `POST /api/completions` — finishing flips the occurrence's completion the
    /// way the web does after `finish`; cancelling a finished session flips it back.
    case completion(completionRow: CompletionRow, logRow: CompletionLogRow)

    public var action: TrackerAction {
        switch self {
        case .start: .start
        case .save: .save
        case .finish: .finish
        case .cancel: .cancel
        case .swapExercise: .swapExercise
        case .completion: .completion
        }
    }

    /// The same op without its client timestamp, or nil when it carries none.
    /// The server accepts stamps only inside `[now − 7d, now + 5min]`; an op
    /// older than that is re-sent unstamped once so the data still lands.
    public func strippingClientTimestamp() -> TrackerOpPayload? {
        switch self {
        case .start(let startedAt) where startedAt != nil:
            return .start(startedAt: nil)
        case .finish(var payload) where payload.finishedAt != nil:
            payload.finishedAt = nil
            return .finish(payload)
        default:
            return nil
        }
    }
}

/// A sent op is deleted, so the only states a stored row can be in are
/// waiting and permanently refused.
public enum TrackerOpState: String, Codable, Sendable {
    case pending, failed
}

public struct TrackerOp: Sendable, Equatable, Identifiable {
    /// Store-assigned, monotonic; 0 until appended. FIFO order within a session.
    public var id: Int64
    public let session: SessionKey
    public var payload: TrackerOpPayload
    public let createdAt: Date
    public var attempts: Int
    public var lastError: String?
    public var state: TrackerOpState

    public init(
        id: Int64 = 0, session: SessionKey, payload: TrackerOpPayload, createdAt: Date,
        attempts: Int = 0, lastError: String? = nil, state: TrackerOpState = .pending
    ) {
        self.id = id
        self.session = session
        self.payload = payload
        self.createdAt = createdAt
        self.attempts = attempts
        self.lastError = lastError
        self.state = state
    }
}

/// Implemented by `ApexPersistence` over GRDB (`tracker_ops`); in memory for
/// tests and as the fallback when SQLite will not open.
public protocol WriteQueueStore: Sendable {
    /// Assigns and returns the id.
    func append(_ op: TrackerOp) async throws -> Int64
    /// By id: payload (a merge), attempts, lastError, state.
    func update(_ op: TrackerOp) async throws
    /// "Sent": a finished op leaves no row behind.
    func delete(id: Int64) async throws
    /// The newest op for the session, whatever its state — the merge candidate.
    func tail(for session: SessionKey) async throws -> TrackerOp?
    /// The oldest op still waiting for the session.
    func nextPending(for session: SessionKey) async throws -> TrackerOp?
    /// Every op for the session, oldest first, all states.
    func ops(for session: SessionKey) async throws -> [TrackerOp]
    func sessionsWithPending() async throws -> [SessionKey]
    /// Every op for the session, all states.
    func purge(session: SessionKey) async throws
    func purgeAll() async throws
}
