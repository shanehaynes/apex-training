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
    private var idleWaiters: [SessionKey: [CheckedContinuation<Void, Never>]] = [:]
    private var cancelledMidFlight: Set<SessionKey> = []
    private var notBefore: [SessionKey: Date] = [:]
    /// Bumped by every `resume()`. An outbox send that fails on the network
    /// while a resume landed mid-flight retries at once: the backoff it would
    /// set was decided before the network came back, and `resume()` already
    /// cleared the gate it would re-close.
    private var resumes = 0
    /// The retry waiting out each session's backoff: the one a cancel, a purge
    /// or a newer retry calls off. A retry leaves it when it fires.
    private var waitingRetry: [SessionKey: UUID] = [:]
    /// Every retry task still running — waiting, flushing, or winding down after
    /// being called off. What `awaitRetries` waits for.
    private var retryTasks: [UUID: Task<Void, Never>] = [:]
    private var subscribers: [UUID: AsyncStream<QueueEvent>.Continuation] = [:]
    /// Lanes whose turn is taken, and who waits for it next (`takeTurn`).
    private var turnTaken: Set<SessionKey> = []
    private var turnWaiters: [SessionKey: [CheckedContinuation<Void, Never>]] = [:]
    /// Bumped by every `purgeAll`. The two writers that add rows (`enqueue`,
    /// `cancelSession`) read it when called and write nothing if it has moved
    /// by the time they would: no call made before a purge lands after it.
    private var purges = 0
    /// `letGo` calls waiting for an op in the air to settle, by op id.
    private var settleWaiters: [Int64: [CheckedContinuation<Void, Never>]] = [:]

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
        let purgesBefore = purges
        await takeTurn(session)
        defer { endTurn(session) }
        if case .save(let incoming) = payload,
           let tail = try await store.tail(for: session),
           tail.state == .pending, inFlight[tail.id] == nil,
           case .save(let existing) = tail.payload {
            let merged = existing.merging(incoming)
            if !merged.exceedsServerCap, purges == purgesBefore {
                var op = tail
                op.payload = .save(merged)
                // The turn should keep the row there, but a save written into
                // a row that has gone is lost without a trace: append instead.
                if try await store.update(op) {
                    emit(.changed(session))
                    return op
                }
            }
        }
        var op = TrackerOp(session: session, payload: payload, createdAt: clock.now)
        // Purged since this was called (the account was deleted): the purge
        // wins, and nothing is written. The op comes back unstored (id 0).
        guard purges == purgesBefore else { return op }
        op.id = try await store.append(op)
        emit(.changed(session))
        return op
    }

    /// Cancelling a workout deletes everything logged for it, so nothing queued
    /// for the session may land after: purge (pending and failed alike), forget
    /// any in-flight op's result, then queue the cancel itself.
    public func cancelSession(_ session: SessionKey) async throws {
        let purgesBefore = purges
        await takeTurn(session)
        defer { endTurn(session) }
        callOffRetry(for: session)
        notBefore[session] = nil
        if inFlight.values.contains(session) { cancelledMidFlight.insert(session) }
        try await store.purge(session: session)
        // A purge since this was called removed the session already.
        guard purges == purgesBefore else { return }
        var op = TrackerOp(session: session, payload: .cancel, createdAt: clock.now)
        op.id = try await store.append(op)
        emit(.changed(session))
    }

    /// Every read-then-write on a lane takes the lane's turn: an enqueue, a
    /// cancel, the drain picking its next op and settling that op's row, and
    /// the user-action writers (`repend`, `retryFailed`, `discardFailed`,
    /// `letGo`). Every store call suspends and this actor is reentrant, so
    /// without a turn an op queued while a save waited on its tail read took
    /// the lower id and was sent first (a Finish ahead of the last set), a
    /// save landed after a cancel, a save merged into a row the drain was
    /// sending was lost with it, and of two taps (Retry, Discard; Let go
    /// during a put-back) the later one could win. The send itself holds no
    /// turn. Turns pass in the order they were asked for, so the lane's ids
    /// follow the order `enqueue` was called in. `discard` only deletes, and
    /// `purgeAll` spans every lane, so neither takes one (`purges`).
    private func takeTurn(_ session: SessionKey) async {
        guard turnTaken.contains(session) else {
            turnTaken.insert(session)
            return
        }
        await withCheckedContinuation { turnWaiters[session, default: []].append($0) }
    }

    /// Hands the turn straight to the next waiter, so nobody arriving in
    /// between can take it out of order.
    private func endTurn(_ session: SessionKey) {
        guard var waiters = turnWaiters[session], !waiters.isEmpty else {
            turnTaken.remove(session)
            return
        }
        let next = waiters.removeFirst()
        turnWaiters[session] = waiters.isEmpty ? nil : waiters
        next.resume()
    }

    // MARK: - Flush

    /// Every session with something pending, concurrently; FIFO within each.
    /// The outbox's gave-up ops are put back first: a foreground, a launch
    /// or a background refresh is their next try (D-052 — nothing in that
    /// lane is dropped for want of a server).
    public func flush() async {
        guard !isPaused else { return }
        await repend(gaveUpIn: .outbox)
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
        // A gave-up op is retried where it stands, never moved behind what
        // was queued after it (the lane is FIFO across waiting ops).
        if session == .outbox { await repend(gaveUpIn: session) }
        await drain(session)
        flushing.remove(session)
        if rerun.remove(session) != nil { await flush(session) }
        if !flushing.contains(session) {
            for waiter in idleWaiters.removeValue(forKey: session) ?? [] { waiter.resume() }
        }
    }

    /// For tests: wait until no flush of the session is running. A flush that
    /// arrives mid-flush returns at once (the running one picks up its op), so
    /// an awaited `flush` alone does not mean the op was sent. Deliberately
    /// not what `flush` does: a finish must reach the store without waiting on
    /// somebody else's send.
    public func untilIdle(_ session: SessionKey) async {
        guard flushing.contains(session) else { return }
        await withCheckedContinuation { idleWaiters[session, default: []].append($0) }
    }

    private func drain(_ session: SessionKey) async {
        while !isPaused {
            if let gate = notBefore[session], gate > clock.now { return }
            guard let op = await pick(in: session) else { return }

            let resumesBefore = resumes
            let outcome: Result<Data, APIError>
            do {
                outcome = .success(try await client.data(for: Endpoint.tracker(op.payload, session: session)))
            } catch let error as APIError {
                outcome = .failure(error)
            } catch {
                outcome = .failure(.network("\(error)"))
            }
            // Settled under the lane's turn, and in flight until it is: a save
            // reading this row as the tail must not merge into a row that is
            // about to be deleted.
            await takeTurn(session)
            defer {
                inFlight[op.id] = nil
                for waiter in settleWaiters.removeValue(forKey: op.id) ?? [] { waiter.resume() }
                endTurn(session)
            }

            if cancelledMidFlight.remove(session) != nil {
                // Purged while this was in the air: its row is gone and its result
                // is moot. The cancel that follows is what matters now.
                try? await store.delete(id: op.id)
                continue
            }

            switch outcome {
            case .success(let data):
                // A Builder save the server refused on validation answers
                // `ok: false` on 200 — nothing was written, and the user has
                // to see why: it fails like any refusal, kept for "Fix".
                if case .workoutDraft = op.payload,
                   let answer = try? JSONDecoder().decode(DraftVerdict.self, from: data), !answer.ok {
                    let message = answer.problem ?? "The server did not accept this workout."
                    var next = op
                    next.attempts += 1
                    next.lastError = message
                    next.state = .failed
                    _ = try? await store.update(next)
                    emit(.failed(session, op.payload.action, message))
                    emit(.changed(session))
                    continue
                }
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
                    _ = try? await store.update(next)
                    continue
                }
                switch verdict(for: error, op: op, in: session) {
                case .retry(let delay):
                    var next = op
                    next.attempts += 1
                    next.lastError = error.description
                    _ = try? await store.update(next)
                    if session == .outbox, resumes != resumesBefore {
                        // The network came back while this was in the air.
                        continue
                    }
                    scheduleRetry(session, after: delay)
                    return
                case .pause:
                    isPaused = true
                    emit(.paused)
                    return
                case .fail(let message):
                    // Permanent, either by status or by running out of retries
                    // (`RetryPolicy.maxAttempts`): keep it, show it, and let the
                    // rest of the session sync — blocking behind one op the
                    // server will never take would mean the whole workout never
                    // lands. `gaveUp` records which of the two it was: a
                    // gave-up op is still waiting and comes back on the next
                    // resume; a refusal waits for the user.
                    var next = op
                    next.attempts += 1
                    next.lastError = message
                    next.state = .failed
                    next.gaveUp = RetryPolicy.isTransient(error)
                    // A 429 is the server's write cap, not a row it will never
                    // take: the op waits like any give-up, but the cap is no
                    // reason to offer letting it go.
                    if next.gaveUp, !RetryPolicy.isRateLimited(error) { next.giveUpCount += 1 }
                    _ = try? await store.update(next)
                    if !next.gaveUp, case .completion(let row, _) = op.payload {
                        // The plan-fill queued behind a completion the server
                        // refused would log a session for an occurrence it did
                        // not mark complete: it goes with the refusal, unsent.
                        await retireQuickComplete(after: op, for: row, in: session)
                    }
                    emit(.failed(session, op.payload.action, message))
                    emit(.changed(session))
                }
            }
        }
    }

    /// The next op, marked in flight before the turn passes on: a save that
    /// then reads it as the tail queues behind it instead of merging into a
    /// payload the drain has already read.
    private func pick(in session: SessionKey) async -> TrackerOp? {
        await takeTurn(session)
        defer { endTurn(session) }
        guard let op = await next(in: session) else { return nil }
        inFlight[op.id] = session
        return op
    }

    /// The op to send next. A tracker session drains past a failed op (the
    /// Retry bar shows it; the rest of the workout must land). The outbox is
    /// FIFO across *waiting* ops: a gave-up op at its head keeps its place
    /// and blocks what was queued after it — a later edit or an undo must not
    /// land before the write it supersedes — until a flush, a resume or
    /// Retry puts it back and it lands, or a refusal retires it. A refusal
    /// never blocks: it waits for the user, off the path.
    private func next(in session: SessionKey) async -> TrackerOp? {
        guard session == .outbox else { return try? await store.nextPending(for: session) }
        let lane = (try? await store.ops(for: session)) ?? []
        guard let head = lane.first(where: \.isWaiting) else { return nil }
        return head.state == .pending ? head : nil
    }

    /// Only the plan-fill of *this* toggle: the first `.quickComplete` for the
    /// occurrence queued after the refused completion, and none past the next
    /// completion for it — a later toggle's plan-fill belongs to that toggle.
    private func retireQuickComplete(after refused: TrackerOp, for row: CompletionRow, in session: SessionKey) async {
        for op in (try? await store.ops(for: session)) ?? [] where op.id > refused.id && op.state == .pending {
            switch op.payload {
            case .completion(let next, _) where next.eventId == row.eventId && next.eventDate == row.eventDate:
                return
            case .quickComplete(let quick) where quick.eventId == row.eventId && quick.eventDate == row.eventDate:
                try? await store.delete(id: op.id)
                return
            default:
                continue
            }
        }
    }

    private func scheduleRetry(_ session: SessionKey, after delay: Double) {
        notBefore[session] = clock.now.addingTimeInterval(delay)
        callOffRetry(for: session)
        let token = UUID()
        waitingRetry[session] = token
        retryTasks[token] = Task { [weak self, clock] in
            try? await clock.sleep(seconds: delay)
            await self?.retryFired(session, token: token)
        }
    }

    /// Cancels the session's waiting retry — never one that has fired, whose
    /// flush is already under way and owns whatever it has in the air.
    private func callOffRetry(for session: SessionKey) {
        guard let token = waitingRetry.removeValue(forKey: session) else { return }
        retryTasks[token]?.cancel()
    }

    /// The retry stays in `retryTasks` until its flush is over, so
    /// `awaitRetries` cannot return while the re-send is still in the air.
    private func retryFired(_ session: SessionKey, token: UUID) async {
        defer { retryTasks[token] = nil }
        // Called off while it waited. Cancelling a sleep ends it early rather
        // than never (`Task.sleep` throws), so this is where the retry stops: it
        // must not re-send, and must not lift the gate a newer retry has set.
        guard waitingRetry[session] == token else { return }
        waitingRetry[session] = nil
        notBefore[session] = nil
        await flush(session)
    }

    /// For tests and the driver: wait for every scheduled retry to have fired
    /// and flushed, including retries those flushes scheduled in turn, and for
    /// every called-off one to have wound down.
    public func awaitRetries() async {
        while let task = retryTasks.values.first {
            await task.value
        }
    }

    // MARK: - Pause / resume

    public func pause() {
        guard !isPaused else { return }
        isPaused = true
        emit(.paused)
    }

    /// Network back, scene active, signed in again: lift the pause and flush.
    /// The outbox lane also drops its backoff wait: its ops only ever wait on
    /// the network (see `verdict`), so this trigger is exactly what they wait for.
    public func resume() async {
        if isPaused {
            isPaused = false
            emit(.resumed)
        }
        resumes += 1
        callOffRetry(for: .outbox)
        notBefore[.outbox] = nil
        await flush()
    }

    /// A gave-up op back to pending with a fresh ladder, in its own place —
    /// the outbox's Retry, and what every flush of that lane does on its own.
    /// A refusal (`isRefused`) is left where it is: only the user can answer it.
    public func retryGaveUp(_ session: SessionKey) async {
        await repend(gaveUpIn: session)
        emit(.changed(session))
        await flush(session)
    }

    private func repend(gaveUpIn session: SessionKey) async {
        await takeTurn(session)
        defer { endTurn(session) }
        for var op in (try? await store.ops(for: session)) ?? [] where op.state == .failed && op.gaveUp {
            op.state = .pending
            op.attempts = 0
            op.lastError = nil
            op.gaveUp = false
            _ = try? await store.update(op)
        }
    }

    /// The policy's verdict, except that a library write never gives up on
    /// the network. A tracker op stops at the ceiling so the session drains
    /// past it and the Retry bar shows it; the outbox lane has no bar, its
    /// creates are idempotent (the server answers a repeat as done), and
    /// nothing queues behind them but other creates — so it waits out an
    /// outage of any length. A 5xx or a refusal still fails as usual.
    private func verdict(for error: APIError, op: TrackerOp, in session: SessionKey) -> RetryPolicy.Verdict {
        if session == .outbox, case .network = error {
            return .retry(after: policy.backoff(attempts: op.attempts))
        }
        return policy.classify(error, attempts: op.attempts)
    }

    // MARK: - Failed ops

    public func retryFailed(_ session: SessionKey) async {
        do {
            await takeTurn(session)
            defer { endTurn(session) }
            for var op in (try? await store.ops(for: session)) ?? [] where op.state == .failed {
                op.state = .pending
                op.attempts = 0
                op.lastError = nil
                op.gaveUp = false
                _ = try? await store.update(op)
            }
        }
        emit(.changed(session))
        await flush(session)
    }

    public func discardFailed(_ session: SessionKey) async {
        await takeTurn(session)
        defer { endTurn(session) }
        for op in (try? await store.ops(for: session)) ?? [] where op.state == .failed {
            try? await store.delete(id: op.id)
        }
        emit(.changed(session))
    }

    /// The two fields of a `/api/workout-draft` answer the queue reads; the
    /// event it carries is the schedule's business, not the queue's.
    private struct DraftVerdict: Decodable {
        let ok: Bool
        let problem: String?
    }

    // MARK: - Reads

    /// Every op in a lane, any state, oldest first — the outbox's pending and
    /// refused Builder saves are read from here.
    public func ops(for session: SessionKey) async -> [TrackerOp] {
        (try? await store.ops(for: session)) ?? []
    }

    /// Drops one op (a refused save the user fixed or dismissed).
    public func discard(_ id: Int64, in session: SessionKey) async {
        try? await store.delete(id: id)
        emit(.changed(session))
    }

    /// The user lets a gave-up op go (`TrackerOp.canLetGo`). Nothing is sent.
    /// An op with content worth keeping — a meal, a Builder save — becomes a
    /// refusal: off the lane's path, kept with what the user typed and listed
    /// with Fix / Delete as a refusal is, under `letGoReason`. A completion
    /// or a plan-fill has nothing to fix and is dropped; a completion's own
    /// plan-fill goes with it, by the rule a refusal uses. Returns what was
    /// let go, for the caller's undo.
    @discardableResult
    public func letGo(_ id: Int64, in session: SessionKey) async -> TrackerOpPayload? {
        // Being sent right now: the send's outcome would be written over the
        // let-go. Wait for it to settle and decide on what it left — gone if
        // it landed, let go if it is still waiting.
        while true {
            while inFlight[id] != nil {
                await withCheckedContinuation { settleWaiters[id, default: []].append($0) }
            }
            await takeTurn(session)
            if inFlight[id] == nil { break }
            endTurn(session)   // picked again before this had the turn
        }
        defer { endTurn(session) }
        guard let op = ((try? await store.ops(for: session)) ?? []).first(where: { $0.id == id }), op.canLetGo else { return nil }
        switch op.payload {
        case .meal, .workoutDraft:
            var kept = op
            kept.state = .failed
            kept.gaveUp = false
            kept.lastError = Self.letGoReason(giveUps: op.giveUpCount)
            _ = try? await store.update(kept)
        default:
            try? await store.delete(id: op.id)
            if case .completion(let row, _) = op.payload {
                await retireQuickComplete(after: op, for: row, in: session)
            }
        }
        emit(.changed(session))
        return op.payload
    }

    /// The reason a let-go op is kept under: what the refusal line shows.
    public static func letGoReason(giveUps: Int) -> String {
        "Let go — given up after \(giveUps) tries."
    }

    /// Every exercise created with no signal and not yet on the server, from
    /// any session (the Library's lane and a tracker's swap). The cached
    /// library is replaced wholesale by each schedule refresh, so its readers
    /// overlay these to keep a pending create on screen until it lands.
    public func pendingDefinitionCreates() async -> [DefinitionCreatePayload] {
        var creates: [DefinitionCreatePayload] = []
        // A create the lane gave up on is still waiting (and still offered);
        // a lane holding only gave-up ops has nothing pending, so the outbox
        // is read whether or not it is listed.
        var sessions = (try? await store.sessionsWithPending()) ?? []
        if !sessions.contains(.outbox) { sessions.append(.outbox) }
        for session in sessions {
            for op in await waitingOps(for: session) {
                if case .createDefinition(let payload) = op.payload { creates.append(payload) }
            }
        }
        return creates
    }

    /// The lane's ops still to land: pending, and failed only for want of a
    /// connection or a working server (`TrackerOp.isWaiting`), oldest first.
    public func waitingOps(for session: SessionKey) async -> [TrackerOp] {
        ((try? await store.ops(for: session)) ?? []).filter(\.isWaiting)
    }

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
        // Counted before anything awaits: an enqueue or a cancel already under
        // way, on any lane, sees it before it writes and writes nothing.
        purges += 1
        for token in waitingRetry.values { retryTasks[token]?.cancel() }
        waitingRetry = [:]
        notBefore = [:]
        try? await store.purgeAll()
    }
}
