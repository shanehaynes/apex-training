import Foundation

/// What the queue tells its observers. `changed` fires whenever a session's
/// counts moved (enqueue, sent, failed, purge, retry); `finished` carries the
/// server's finish response once that op lands, which is how an offline finish
/// gets its PRs and recap later.
public enum QueueEvent: Sendable, Equatable {
    case changed(SessionKey)
    /// Nil when the server answered 2xx with a body that did not decode — the
    /// session *is* finished (the handler returns 200 with empty PRs on its
    /// degraded paths), it just has nothing to show.
    case finished(SessionKey, FinishResponse?)
    case failed(SessionKey, TrackerAction, String)
    case paused
    case resumed
}

/// What the tracker shows about one session's queue: the "N sets pending sync"
/// chip and the "M sets could not be saved" bar.
public struct SessionSyncStatus: Sendable, Equatable {
    public var pendingSets: Int
    public var pendingCardio: Int
    public var pendingOps: Int
    public var hasPendingStart: Bool
    public var hasPendingFinish: Bool
    public var failedSets: Int
    public var failedOps: Int
    public var lastError: String?

    public init(
        pendingSets: Int = 0, pendingCardio: Int = 0, pendingOps: Int = 0,
        hasPendingStart: Bool = false, hasPendingFinish: Bool = false,
        failedSets: Int = 0, failedOps: Int = 0, lastError: String? = nil
    ) {
        self.pendingSets = pendingSets
        self.pendingCardio = pendingCardio
        self.pendingOps = pendingOps
        self.hasPendingStart = hasPendingStart
        self.hasPendingFinish = hasPendingFinish
        self.failedSets = failedSets
        self.failedOps = failedOps
        self.lastError = lastError
    }

    public static let idle = SessionSyncStatus()
    public var isIdle: Bool { self == .idle }
}

/// The tracker write queue (architecture.md §7). FIFO per session, sessions
/// independent; consecutive unsent saves merge into one; failures are
/// classified by `RetryPolicy`; `cancel` purges everything queued for the
/// session first. A pure state machine over a `WriteQueueStore` and an
/// `ApexClock`, so every rule here is proved by `swift test` on Linux. The flush
/// triggers (network path, scene phase, background task) live in the app target
/// and just call `flush()` / `resume()`.
public actor WriteQueue {
    private let store: any WriteQueueStore
    private let client: ApexClient
    private let clock: any ApexClock
    private let policy: RetryPolicy

    public private(set) var isPaused = false
    private var inFlight: [Int64: SessionKey] = [:]
    private var flushing: Set<SessionKey> = []
    private var rerun: Set<SessionKey> = []
    private var cancelledMidFlight: Set<SessionKey> = []
    private var notBefore: [SessionKey: Date] = [:]
    private var retryTasks: [SessionKey: (token: UUID, task: Task<Void, Never>)] = [:]
    private var subscribers: [UUID: AsyncStream<QueueEvent>.Continuation] = [:]

    public init(
        store: any WriteQueueStore, client: ApexClient,
        clock: any ApexClock = SystemClock(), policy: RetryPolicy = .default
    ) {
        self.store = store
        self.client = client
        self.clock = clock
        self.policy = policy
    }

    // MARK: - Enqueue

    /// A `save` merges into the session's newest op when that op is an unsent
    /// save nobody is sending right now (last write per key wins, removals
    /// carried); everything else appends. Never merges into an in-flight op: if
    /// that one fails and returns to pending, the later save is simply the new
    /// tail. Does not flush — the caller decides when.
    @discardableResult
    public func enqueue(_ payload: TrackerOpPayload, for session: SessionKey) async throws -> TrackerOp {
        if case .save(let incoming) = payload,
           let tail = try await store.tail(for: session),
           tail.state == .pending, inFlight[tail.id] == nil,
           case .save(let existing) = tail.payload {
            let merged = existing.merging(incoming)
            if !merged.exceedsServerCap {
                var op = tail
                op.payload = .save(merged)
                try await store.update(op)
                emit(.changed(session))
                return op
            }
        }
        var op = TrackerOp(session: session, payload: payload, createdAt: clock.now)
        op.id = try await store.append(op)
        emit(.changed(session))
        return op
    }

    /// Cancelling a workout deletes everything logged for it, so nothing queued
    /// for the session may land after: purge (pending and failed alike), forget
    /// any in-flight op's result, then queue the cancel itself.
    public func cancelSession(_ session: SessionKey) async throws {
        retryTasks[session]?.task.cancel()
        retryTasks[session] = nil
        notBefore[session] = nil
        if inFlight.values.contains(session) { cancelledMidFlight.insert(session) }
        try await store.purge(session: session)
        var op = TrackerOp(session: session, payload: .cancel, createdAt: clock.now)
        op.id = try await store.append(op)
        emit(.changed(session))
    }

    // MARK: - Flush

    /// Every session with something pending, concurrently; FIFO within each.
    public func flush() async {
        guard !isPaused else { return }
        let sessions = (try? await store.sessionsWithPending()) ?? []
        await withTaskGroup(of: Void.self) { group in
            for session in sessions {
                group.addTask { await self.flush(session) }
            }
        }
    }

    /// One flush per session at a time; a call that arrives mid-flush queues one
    /// more pass so a save enqueued during a send is not left waiting for the
    /// next trigger.
    public func flush(_ session: SessionKey) async {
        guard !isPaused else { return }
        if flushing.contains(session) {
            rerun.insert(session)
            return
        }
        flushing.insert(session)
        await drain(session)
        flushing.remove(session)
        if rerun.remove(session) != nil { await flush(session) }
    }

    private func drain(_ session: SessionKey) async {
        while !isPaused {
            if let gate = notBefore[session], gate > clock.now { return }
            guard let op = try? await store.nextPending(for: session) else { return }

            inFlight[op.id] = session
            let outcome: Result<Data, APIError>
            do {
                outcome = .success(try await client.data(for: Endpoint.tracker(op.payload, session: session)))
            } catch let error as APIError {
                outcome = .failure(error)
            } catch {
                outcome = .failure(.network("\(error)"))
            }
            inFlight[op.id] = nil

            if cancelledMidFlight.remove(session) != nil {
                // Purged while this was in the air: its row is gone and its result
                // is moot. The cancel that follows is what matters now.
                try? await store.delete(id: op.id)
                continue
            }

            switch outcome {
            case .success(let data):
                try? await store.delete(id: op.id)
                if case .finish = op.payload {
                    emit(.finished(session, try? JSONDecoder().decode(FinishResponse.self, from: data)))
                }
                emit(.changed(session))

            case .failure(let error):
                if RetryPolicy.isTimestampWindowRejection(error), let stripped = op.payload.strippingClientTimestamp() {
                    // Older than the server's window: send it unstamped so the
                    // data lands (the server stamps now; the duration is lost).
                    var next = op
                    next.payload = stripped
                    next.attempts += 1
                    next.lastError = error.description
                    try? await store.update(next)
                    continue
                }
                switch policy.classify(error, attempts: op.attempts) {
                case .retry(let delay):
                    var next = op
                    next.attempts += 1
                    next.lastError = error.description
                    try? await store.update(next)
                    scheduleRetry(session, after: delay)
                    return
                case .pause:
                    isPaused = true
                    emit(.paused)
                    return
                case .fail(let message):
                    // Permanent: keep it, show it, and let the rest of the
                    // session sync — blocking behind a client bug would mean the
                    // whole workout never lands.
                    var next = op
                    next.attempts += 1
                    next.lastError = message
                    next.state = .failed
                    try? await store.update(next)
                    emit(.failed(session, op.payload.action, message))
                    emit(.changed(session))
                }
            }
        }
    }

    private func scheduleRetry(_ session: SessionKey, after delay: Double) {
        notBefore[session] = clock.now.addingTimeInterval(delay)
        retryTasks[session]?.task.cancel()
        let token = UUID()
        let task = Task { [weak self, clock] in
            try? await clock.sleep(seconds: delay)
            await self?.retryFired(session, token: token)
        }
        retryTasks[session] = (token, task)
    }

    /// The retry stays registered until its flush is over, so `awaitRetries`
    /// cannot return while the re-send is still in the air. A newer retry
    /// scheduled by that flush replaces the registration and is left alone.
    private func retryFired(_ session: SessionKey, token: UUID) async {
        notBefore[session] = nil
        await flush(session)
        if retryTasks[session]?.token == token { retryTasks[session] = nil }
    }

    /// For tests and the driver: wait for every scheduled retry to have fired
    /// and flushed, including retries those flushes scheduled in turn.
    public func awaitRetries() async {
        while let entry = retryTasks.values.first {
            await entry.task.value
        }
    }

    // MARK: - Pause / resume

    public func pause() {
        guard !isPaused else { return }
        isPaused = true
        emit(.paused)
    }

    /// Network back, scene active, signed in again: lift the pause and flush.
    public func resume() async {
        if isPaused {
            isPaused = false
            emit(.resumed)
        }
        await flush()
    }

    // MARK: - Failed ops

    public func retryFailed(_ session: SessionKey) async {
        for var op in (try? await store.ops(for: session)) ?? [] where op.state == .failed {
            op.state = .pending
            op.attempts = 0
            op.lastError = nil
            try? await store.update(op)
        }
        emit(.changed(session))
        await flush(session)
    }

    public func discardFailed(_ session: SessionKey) async {
        for op in (try? await store.ops(for: session)) ?? [] where op.state == .failed {
            try? await store.delete(id: op.id)
        }
        emit(.changed(session))
    }

    // MARK: - Reads

    public func status(for session: SessionKey) async -> SessionSyncStatus {
        var status = SessionSyncStatus()
        var pendingSets = Set<SetKey>(), pendingCardio = Set<CardioKey>(), failedSets = Set<SetKey>()
        for op in (try? await store.ops(for: session)) ?? [] {
            switch op.state {
            case .pending:
                status.pendingOps += 1
                switch op.payload {
                case .save(let payload):
                    pendingSets.formUnion(payload.setKeys)
                    pendingCardio.formUnion(payload.cardioKeys)
                case .start: status.hasPendingStart = true
                case .finish: status.hasPendingFinish = true
                default: break
                }
            case .failed:
                status.failedOps += 1
                if case .save(let payload) = op.payload { failedSets.formUnion(payload.setKeys) }
                if let error = op.lastError { status.lastError = error }
            }
        }
        status.pendingSets = pendingSets.count
        status.pendingCardio = pendingCardio.count
        status.failedSets = failedSets.count
        return status
    }

    public func pendingOps(for session: SessionKey) async -> [TrackerOp] {
        ((try? await store.ops(for: session)) ?? []).filter { $0.state == .pending }
    }

    /// The unsent saves, oldest first — replayed onto the editor when the
    /// tracker opens so the screen shows edits the server has not seen.
    public func pendingSaves(for session: SessionKey) async -> [SavePayload] {
        await pendingOps(for: session).compactMap {
            if case .save(let payload) = $0.payload { return payload }
            return nil
        }
    }

    public func pendingSwaps(for session: SessionKey) async -> [SwapPayload] {
        await pendingOps(for: session).compactMap {
            if case .swapExercise(let payload) = $0.payload { return payload }
            return nil
        }
    }

    /// The start stamp still waiting to land, so the online bootstrap can carry
    /// it and both paths converge on the same `started_at`.
    public func pendingStart(for session: SessionKey) async -> String?? {
        for op in await pendingOps(for: session) {
            if case .start(let startedAt) = op.payload { return .some(startedAt) }
        }
        return nil
    }

    public func pendingFinish(for session: SessionKey) async -> FinishPayload? {
        for op in await pendingOps(for: session) {
            if case .finish(let payload) = op.payload { return payload }
        }
        return nil
    }

    // MARK: - Observation

    /// A fresh stream per caller — `AsyncStream` is single-consumer, and the open
    /// tracker and a schedule badge may both be listening.
    public func subscribe() -> AsyncStream<QueueEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<QueueEvent>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        return stream
    }

    private func unsubscribe(_ id: UUID) {
        subscribers[id] = nil
    }

    private func emit(_ event: QueueEvent) {
        for continuation in subscribers.values { continuation.yield(event) }
    }

    // MARK: - Teardown

    /// Everything, every session. Sign-out does *not* call this — unsynced
    /// workout data outlives the session and flushes when its owner is back
    /// (the store is per owner); this is for tests and a deliberate reset.
    public func purgeAll() async {
        for entry in retryTasks.values { entry.task.cancel() }
        retryTasks = [:]
        notBefore = [:]
        try? await store.purgeAll()
    }
}
