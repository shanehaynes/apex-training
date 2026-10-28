import XCTest
@testable import ApexCore

/// The write queue state machine (architecture.md §7), over a scripted transport,
/// an in-memory store and a `TestClock` — backoff runs instantly and is asserted
/// on the recorded sleeps. A test that reads the queue between a failure and its
/// retry holds the retry on a `HeldClock` instead: under `TestClock` the retry
/// can fire before the test's next line. A call a test starts in a task of its
/// own is waited for until the queue reports it parked (`waitFor`), never
/// assumed after a run of `Task.yield()`: under load the task may not have run.
final class WriteQueueTests: XCTestCase {
    private let session = fixtureSession
    private let other = SessionKey(eventId: "ios-fixture-run", eventDate: "2026-09-08")

    private func makeQueue(
        _ transport: ScriptedTransport, store: MemoryWriteQueueStore = MemoryWriteQueueStore(),
        clock: any ApexClock = TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)),
        policy: RetryPolicy = .default
    ) -> WriteQueue {
        WriteQueue(store: store, client: makeClient(transport), clock: clock, policy: policy)
    }

    private func save(_ rows: [SetLogRow], removed: [SetKey] = []) -> TrackerOpPayload {
        .save(SavePayload(setLogs: rows, removedSets: removed))
    }

    /// Waits until `count` sleeps are held on `clock`. Each retry is a task of its
    /// own, so it reaches the clock some time after the flush that scheduled it
    /// returns, and two retries reach it in no promised order.
    private func waitForHeldSleeps(
        _ count: Int, on clock: HeldClock, file: StaticString = #filePath, line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(5)
        while clock.heldSleeps < count, Date() < deadline {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertEqual(clock.heldSleeps, count, "sleeps held on the clock", file: file, line: line)
    }

    /// Waits until `value` reads `expected` (five seconds at most), then asserts
    /// it. A call started in a task of its own reaches the queue some time
    /// after the task is made, in no promised order with other tasks: a step
    /// that needs the call parked inside the queue waits for the queue to say so.
    private func waitFor(
        _ expected: Int, _ what: String, file: StaticString = #filePath, line: UInt = #line,
        _ value: () async -> Int
    ) async {
        let deadline = Date().addingTimeInterval(5)
        while await value() != expected, Date() < deadline {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        let last = await value()
        XCTAssertEqual(last, expected, what, file: file, line: line)
    }

    private func waitForTurnWaiters(
        _ count: Int, on queue: WriteQueue, in session: SessionKey, file: StaticString = #filePath, line: UInt = #line
    ) async {
        await waitFor(count, "calls parked on the lane's turn", file: file, line: line) {
            await queue.turnWaiterCount(for: session)
        }
    }

    // MARK: - Send

    func testASaveFlushesAsOnePostAndLeavesNoRow() async throws {
        let transport = ScriptedTransport()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())

        try await queue.enqueue(save([setRow(1, weight: "120 lb", reps: "3")]), for: session)
        let v1 = await store.all.count
        XCTAssertEqual(v1, 1)
        await queue.flush(session)

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].method, "POST")
        XCTAssertEqual(requests[0].path, "/api/workout-sessions")
        XCTAssertEqual(requests[0].action, "save")
        XCTAssertEqual(requests[0].body?["eventId"] as? String, session.eventId)
        let setLogs = requests[0].body?["setLogs"] as? [[String: Any]]
        XCTAssertEqual(setLogs?.count, 1)
        XCTAssertEqual(setLogs?[0]["actual_weight"] as? String, "120 lb")
        XCTAssertEqual((requests[0].body?["removedSets"] as? [Any])?.count, 0)
        let v2 = await store.all.count
        XCTAssertEqual(v2, 0)
        let events = await recorder.waitFor { $0.count >= 2 }
        XCTAssertEqual(events, [.changed(session), .changed(session)])
        await recorder.stop()
    }

    func testOfflineSavesMergeIntoOneOp() async throws {
        let transport = ScriptedTransport()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(save([setRow(1, weight: "100"), setRow(2, weight: "100")]), for: session)
        try await queue.enqueue(save([setRow(2, weight: "110")], removed: [SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 3)]), for: session)
        try await queue.enqueue(save([setRow(3, weight: "120")]), for: session)
        let v3 = await store.all.count
        XCTAssertEqual(v3, 1)

        await queue.flush(session)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        let rows = requests[0].body?["setLogs"] as? [[String: Any]]
        XCTAssertEqual(rows?.map { $0["set_number"] as? Int }, [1, 2, 3])
        XCTAssertEqual(rows?.map { $0["actual_weight"] as? String }, ["100", "110", "120"])
        // Removed then re-added: only an upsert survives.
        XCTAssertEqual((requests[0].body?["removedSets"] as? [Any])?.count, 0)
    }

    func testNoMergeIntoAnInFlightSave() async throws {
        let transport = ScriptedTransport()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let gate = Gate()
        await transport.hold(with: gate)
        try await queue.enqueue(save([setRow(1, weight: "100")]), for: session)

        let flush = Task { [session] in await queue.flush(session) }
        // Give the flush a moment to reach the transport.
        while await transport.count == 0 { await Task.yield() }
        try await queue.enqueue(save([setRow(1, weight: "105")]), for: session)
        let v4 = await store.all.count
        XCTAssertEqual(v4, 2)
        await gate.open()
        await flush.value

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        let weights = requests.map { ($0.body?["setLogs"] as? [[String: Any]])?.first?["actual_weight"] as? String }
        XCTAssertEqual(weights, ["100", "105"])
        let v5 = await store.all.count
        XCTAssertEqual(v5, 0)
    }

    func testNoMergeAcrossActions() async throws {
        let transport = ScriptedTransport()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(.start(startedAt: "2026-09-08T12:00:00.000Z"), for: session)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: "2026-09-08T12:30:00.000Z")), for: session)
        try await queue.enqueue(save([setRow(2)]), for: session)
        let v6 = await store.all.map(\.payload.action)
        XCTAssertEqual(v6, [.start, .save, .finish, .save])
        await queue.flush(session)
        let v7 = await transport.requests.map(\.action)
        XCTAssertEqual(v7, ["start", "save", "finish", "save"])
    }

    func testMergeRefusesPastTheServerCapAndAppends() async throws {
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(ScriptedTransport(), store: store)
        try await queue.enqueue(save((1...500).map { setRow($0) }), for: session)
        try await queue.enqueue(save([setRow(501)]), for: session)
        let v8 = await store.all.count
        XCTAssertEqual(v8, 2)
    }

    // MARK: - Ordering and failure

    func testANetworkFailureStopsTheChainAndBackoffResumesItInOrder() async throws {
        let transport = ScriptedTransport([.throwNetwork, .ok(), .ok()])
        let clock = HeldClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)

        await queue.flush(session)
        // The failure stopped the chain: finish did not go out behind a lost save.
        let v9 = await transport.requests.map(\.action)
        XCTAssertEqual(v9, ["save"])
        clock.open()
        await queue.awaitRetries()
        let v10 = await transport.requests.map(\.action)
        XCTAssertEqual(v10, ["save", "save", "finish"])
        XCTAssertEqual(clock.sleeps, [1])
    }

    func testSessionsAreIndependent() async throws {
        let transport = ScriptedTransport([.throwNetwork, .ok()])
        let store = MemoryWriteQueueStore()
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(save([setRow(1, exerciseId: "fx-row")]), for: other)
        await queue.flush()
        clock.open()
        await queue.awaitRetries()
        // Both sessions were attempted in the first pass — whichever went first
        // failed and did not hold the other back — then the failed one retried.
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 3)
        let firstPass = Set(requests.prefix(2).map { $0.body?["eventId"] as? String })
        XCTAssertEqual(firstPass, [session.eventId, other.eventId])
        let remaining = await store.all
        XCTAssertEqual(remaining.count, 0)
    }

    func testBackoffVector() async throws {
        let transport = ScriptedTransport([.throwNetwork, .status(503), .throwNetwork, .status(500), .ok()])
        let clock = HeldClock()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)
        let v14 = await store.all.first?.attempts
        XCTAssertEqual(v14, 1)
        let v15 = await store.all.first?.lastError
        XCTAssertEqual(v15, "No connection.")
        clock.open()
        await queue.awaitRetries()
        XCTAssertEqual(clock.sleeps, [1, 2, 4, 8])
        let v16 = await transport.count
        XCTAssertEqual(v16, 5)
        let v17 = await store.all.count
        XCTAssertEqual(v17, 0)
    }

    func testARetryCalledOffByANewerOneOrAPurgeNeverFires() async throws {
        let transport = ScriptedTransport([.throwNetwork, .throwNetwork, .ok()])
        let clock = HeldClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)  // fails: a 1s retry waits on the clock
        await waitForHeldSleeps(1, on: clock)
        // A trigger lands after that backoff but before its sleep ends; its send
        // fails too, and the 2s retry it schedules replaces the 1s one.
        clock.advance(by: 1)
        await queue.flush(session)
        await waitForHeldSleeps(2, on: clock)  // the called-off 1s sleep stays held until open()
        XCTAssertEqual(clock.cancelledHeldSleeps, 1, "the 2s retry called off the 1s one")
        await queue.purgeAll()  // calls off the 2s retry
        XCTAssertEqual(clock.cancelledHeldSleeps, 2, "the purge called off the 2s retry")
        try await queue.enqueue(save([setRow(2)]), for: session)

        // Calling a retry off cancels its sleep, which ends it early (`Task.sleep`
        // throws). Neither may fire: the new save waits for a trigger of its own.
        clock.open()
        await queue.awaitRetries()
        let sent = await transport.count
        XCTAssertEqual(sent, 2)
        XCTAssertEqual(clock.sleeps, [1, 2])
        let queued = await queue.pendingSaves(for: session).count
        XCTAssertEqual(queued, 1)
    }

    func testACalledOffRetryWindingDownLeavesTheNewerOnesBackoffInPlace() async throws {
        // A called-off retry's sleep ends at once, so it winds down while the
        // retry that replaced it still waits. It must not lift that retry's
        // backoff on its way out: a trigger in the meantime sends nothing.
        let transport = ScriptedTransport([.throwNetwork, .throwNetwork, .ok()])
        let clock = HeldClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)  // fails: a 1s retry waits on the clock
        await waitForHeldSleeps(1, on: clock)
        clock.advance(by: 1)
        await queue.flush(session)  // fails: the 2s retry calls off the 1s one
        await waitForHeldSleeps(2, on: clock)
        clock.endCancelled()        // the 1s retry winds down; the 2s one still waits
        await waitFor(1, "retries still running") { await queue.retryTaskCount }
        await queue.flush(session)  // a trigger inside the 2s backoff
        let early = await transport.count
        XCTAssertEqual(early, 2, "sent inside the newer retry's backoff")

        clock.open()
        await queue.awaitRetries()
        let sent = await transport.requests.map(\.action)
        XCTAssertEqual(sent, ["save", "save", "save"], "the 2s retry sends it")
        XCTAssertEqual(clock.sleeps, [1, 2])
    }

    func testRateLimitHonoursRetryAfter() async throws {
        let transport = ScriptedTransport([.status(429, headers: ["Retry-After": "7"]), .ok()])
        let clock = TestClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)
        await queue.awaitRetries()
        XCTAssertEqual(clock.sleeps, [7])
        let v18 = await transport.count
        XCTAssertEqual(v18, 2)
    }

    /// W16 MT: the terms gate holds the write, it does not refuse it — the set
    /// stays pending through the consent screen and lands on the resume that
    /// accepting sends.
    func testTheTermsGatePausesAndTheSetLandsAfterAccepting() async throws {
        let transport = ScriptedTransport([.status(403, body: "terms-acceptance-required"), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)

        let paused = await queue.isPaused
        XCTAssertTrue(paused)
        let held = await store.all.map(\.state)
        XCTAssertEqual(held, [.pending], "kept, not refused")

        await queue.resume()
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        let sent = await transport.count
        XCTAssertEqual(sent, 2)
    }

    func testUnauthorizedPausesUntilResumed() async throws {
        // Two 401s: the client refreshes once, retries once, then gives up.
        let transport = ScriptedTransport([.status(401), .status(401), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)

        let v19 = await queue.isPaused
        XCTAssertTrue(v19)
        let v20 = await transport.count
        XCTAssertEqual(v20, 2)
        let v21 = await store.all.map(\.state)
        XCTAssertEqual(v21, [.pending])
        // Paused: nothing moves.
        await queue.flush(session)
        let v22 = await transport.count
        XCTAssertEqual(v22, 2)

        await queue.resume()
        let v23 = await queue.isPaused
        XCTAssertFalse(v23)
        let v24 = await transport.count
        XCTAssertEqual(v24, 3)
        let v25 = await store.all.count
        XCTAssertEqual(v25, 0)
        let events = await recorder.waitFor { $0.contains(.resumed) }
        XCTAssertTrue(events.contains(.paused))
        await recorder.stop()
    }

    func testAPermanentFailureIsKeptShownAndDoesNotBlockTheSession() async throws {
        let transport = ScriptedTransport([.status(400, body: "Invalid score"), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(save([setRow(1), setRow(2)]), for: session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)
        await queue.flush(session)

        let v26 = await transport.requests.map(\.action)
        XCTAssertEqual(v26, ["save", "finish"])
        let remaining = await store.all
        XCTAssertEqual(remaining.map(\.state), [.failed])
        XCTAssertEqual(remaining[0].lastError, "Invalid score")
        let status = await queue.status(for: session)
        XCTAssertEqual(status.failedSets, 2)
        XCTAssertEqual(status.failedOps, 1)
        XCTAssertEqual(status.pendingOps, 0)
        XCTAssertEqual(status.lastError, "Invalid score")
        let events = await recorder.waitFor { $0.contains { if case .failed = $0 { return true }; return false } }
        XCTAssertTrue(events.contains(.failed(session, .save, "Invalid score")))

        // Retry re-sends it; discard deletes it.
        await queue.retryFailed(session)
        let v27 = await store.all.count
        XCTAssertEqual(v27, 0)
        let v28 = await transport.count
        XCTAssertEqual(v28, 3)

        await transport.script([.status(400, body: "nope")])
        try await queue.enqueue(save([setRow(3)]), for: session)
        await queue.flush(session)
        let v29 = await store.all.map(\.state)
        XCTAssertEqual(v29, [.failed])
        await queue.discardFailed(session)
        let v30 = await store.all.count
        XCTAssertEqual(v30, 0)
        await recorder.stop()
    }

    func testAForever500StopsAtTheCeilingAndTheSessionDrainsPastIt() async throws {
        // Four 500s against a three-attempt ceiling, then the finish behind it.
        let transport = ScriptedTransport([
            .status(500, body: "boom"), .status(500, body: "boom"),
            .status(500, body: "boom"), .status(500, body: "boom"), .ok(),
        ])
        let store = MemoryWriteQueueStore()
        // Holds each backoff so the ladder is asserted, not raced.
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock, policy: RetryPolicy(maxAttempts: 3))
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(save([setRow(1), setRow(2)]), for: session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)

        await queue.flush(session)
        // Still retrying, and the finish is still held behind the save.
        let firstPass = await transport.requests.map(\.action)
        XCTAssertEqual(firstPass, ["save"])
        clock.open()
        await queue.awaitRetries()

        let message = "Could not sync after 4 attempts. boom"
        let sent = await transport.requests.map(\.action)
        XCTAssertEqual(sent, ["save", "save", "save", "save", "finish"])
        XCTAssertEqual(clock.sleeps, [1, 2, 4])
        let remaining = await store.all
        XCTAssertEqual(remaining.map(\.state), [.failed])
        XCTAssertEqual(remaining[0].attempts, 4)
        XCTAssertEqual(remaining[0].lastError, message)
        let status = await queue.status(for: session)
        XCTAssertEqual(status.pendingOps, 0)
        XCTAssertFalse(status.hasPendingFinish)
        XCTAssertEqual(status.failedOps, 1)
        XCTAssertEqual(status.failedSets, 2)
        XCTAssertEqual(status.lastError, message)
        let failure = QueueEvent.failed(session, .save, message)
        let events = await recorder.waitFor { $0.contains(failure) }
        XCTAssertTrue(events.contains(failure))

        // Retry from the bar starts the ladder over: the next send succeeds.
        await queue.retryFailed(session)
        await queue.awaitRetries()
        let after = await transport.requests.map(\.action)
        XCTAssertEqual(after, ["save", "save", "save", "save", "finish", "save"])
        let empty = await store.all.count
        XCTAssertEqual(empty, 0)
        await recorder.stop()
    }

    func testANetworkOutageStillRetriesUpToTheCeiling() async throws {
        // The default policy grants eight retries before giving up; nine
        // failures in a row is what a permanently broken op looks like.
        let transport = ScriptedTransport([.throwNetwork])
        let store = MemoryWriteQueueStore()
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)
        clock.open()
        await queue.awaitRetries()

        let sent = await transport.count
        XCTAssertEqual(sent, 9)
        XCTAssertEqual(clock.sleeps, [1, 2, 4, 8, 16, 32, 64, 128])
        let remaining = await store.all
        XCTAssertEqual(remaining.map(\.state), [.failed])
        XCTAssertEqual(remaining[0].lastError, "Could not sync after 9 attempts. No connection.")
    }

    func testTimestampOutsideTheWindowIsResentUnstampedOnce() async throws {
        let transport = ScriptedTransport([.status(400, body: "startedAt must be an ISO timestamp within the last 7 days"), .ok()])
        let queue = makeQueue(transport)
        try await queue.enqueue(.start(startedAt: "2026-08-01T00:00:00.000Z"), for: session)
        await queue.flush(session)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.action), ["start", "start"])
        XCTAssertEqual(requests[0].body?["startedAt"] as? String, "2026-08-01T00:00:00.000Z")
        XCTAssertNil(requests[1].body?["startedAt"])
    }

    // MARK: - Cancel

    func testCancelPurgesTheSessionAndSendsOneCancel() async throws {
        let transport = ScriptedTransport([.throwNetwork, .ok()])
        let store = MemoryWriteQueueStore()
        // Holds the retry: under `TestClock` it could re-send the save before the cancel purges it.
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(save([setRow(1, exerciseId: "fx-row")]), for: other)
        await queue.flush(session)  // fails, schedules a retry
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)

        try await queue.cancelSession(session)
        let ops = await store.all
        XCTAssertEqual(ops.map(\.session), [other, session])
        XCTAssertEqual(ops.last?.payload, .cancel)

        clock.open()
        await transport.script([.ok()])
        await queue.flush()
        await queue.awaitRetries()
        let v31 = await transport.requests.filter { $0.body?["eventId"] as? String == self.session.eventId }.map(\.action)
        XCTAssertEqual(v31, ["save", "cancel"])
        let v32 = await store.all.count
        XCTAssertEqual(v32, 0)
    }

    func testCancelDuringAnInFlightSaveIgnoresItsResult() async throws {
        let transport = ScriptedTransport()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let gate = Gate()
        await transport.hold(with: gate)
        try await queue.enqueue(save([setRow(1)]), for: session)
        let flush = Task { [session] in await queue.flush(session) }
        while await transport.count == 0 { await Task.yield() }

        try await queue.cancelSession(session)
        await gate.open()
        await flush.value
        // The save's success was ignored; the cancel went out after it; nothing is left.
        let v33 = await transport.requests.map(\.action)
        XCTAssertEqual(v33, ["save", "cancel"])
        let v34 = await store.all.count
        XCTAssertEqual(v34, 0)
    }

    func testCancelCallsOffTheSessionsWaitingRetry() async throws {
        let transport = ScriptedTransport([.throwNetwork, .ok()])
        let clock = HeldClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)  // fails: a retry waits on the clock

        try await queue.cancelSession(session)
        // Calling the retry off cancels its sleep, which ends it early (`Task.sleep`
        // throws). It must not fire: nothing flushed, so the cancel is still queued.
        clock.open()
        await queue.awaitRetries()
        let sent = await transport.requests.map(\.action)
        XCTAssertEqual(sent, ["save"])
        let queued = await queue.pendingOps(for: session).map(\.payload)
        XCTAssertEqual(queued, [.cancel])
    }

    // MARK: - Finish

    func testFinishEmitsTheDecodedResponse() async throws {
        let transport = ScriptedTransport([.respond(HTTPResponse(status: 200, body: try TestFixtures.data("finish.json"))), .ok("garbage")])
        let queue = makeQueue(transport)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)
        await queue.flush(session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: other)
        await queue.flush(other)

        let events = await recorder.waitFor { $0.filter { if case .finished = $0 { return true }; return false }.count == 2 }
        let finished = events.compactMap { event -> (SessionKey, FinishResponse?)? in
            if case .finished(let s, let r) = event { return (s, r) }
            return nil
        }
        XCTAssertEqual(finished[0].0, session)
        XCTAssertEqual(finished[0].1?.prs.first?.exerciseName, "Fixture Press")
        XCTAssertEqual(finished[1].0, other)
        // A 200 that does not decode is still a finished session, not a retry.
        XCTAssertNil(finished[1].1)
        let v35 = await transport.count
        XCTAssertEqual(v35, 2)
        await recorder.stop()
    }

    // MARK: - Reads

    func testStatusDedupesKeysAcrossPendingSaves() async throws {
        let transport = ScriptedTransport([.throwNetwork])
        // Holds the retry: the ops must still be pending when the status is read,
        // and a transport that always fails would otherwise reach the ceiling.
        let clock = HeldClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(.start(startedAt: nil), for: session)
        await queue.flush(session)  // start fails → pending; later saves cannot merge into it
        try await queue.enqueue(save([setRow(1), setRow(2)]), for: session)
        try await queue.enqueue(.swapExercise(SwapPayload(section: "exercise", exerciseId: "fx-press", exerciseName: "Incline Press", definitionId: "d")), for: session)
        try await queue.enqueue(save([setRow(2), setRow(3)], removed: [SetKey(section: "exercise", exerciseId: "fx-press", setNumber: 4)]), for: session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: "x")), for: session)

        let status = await queue.status(for: session)
        XCTAssertEqual(status.pendingSets, 4)
        XCTAssertEqual(status.pendingOps, 5)
        XCTAssertTrue(status.hasPendingStart)
        XCTAssertTrue(status.hasPendingFinish)
        XCTAssertEqual(status.failedOps, 0)
        let v36 = await queue.pendingSaves(for: session).count
        XCTAssertEqual(v36, 2)
        let v37 = await queue.pendingSwaps(for: session).map(\.exerciseName)
        XCTAssertEqual(v37, ["Incline Press"])
        let v38 = await queue.pendingStart(for: session)
        XCTAssertEqual(v38, .some(nil))
        let v39 = await queue.pendingFinish(for: session)?.finishedAt
        XCTAssertEqual(v39, "x")
        let v40 = await queue.pendingStart(for: other)
        XCTAssertNil(v40)
        let v41 = await queue.status(for: other)
        XCTAssertEqual(v41, .idle)

        // Let the held retry wind down rather than leaving it suspended.
        await queue.purgeAll()
        clock.open()
        await queue.awaitRetries()
    }

    func testARelaunchReplaysWhatTheLastRunLeft() async throws {
        let store = MemoryWriteQueueStore()
        // The first run's retry is held: this is the crash-before-it-retried case.
        let clock = HeldClock()
        let first = makeQueue(ScriptedTransport([.throwNetwork]), store: store, clock: clock)
        try await first.enqueue(save([setRow(1)]), for: session)
        await first.flush(session)
        let v42 = await store.all.count
        XCTAssertEqual(v42, 1)

        let transport = ScriptedTransport()
        let second = makeQueue(transport, store: store)
        await second.flush()
        let v43 = await transport.requests.map(\.action)
        XCTAssertEqual(v43, ["save"])
        let v44 = await store.all.count
        XCTAssertEqual(v44, 0)

        await first.purgeAll()
        clock.open()
        await first.awaitRetries()
    }

    func testConcurrentFlushesCoalesceToOneChain() async throws {
        let transport = ScriptedTransport()
        let queue = makeQueue(transport)
        let gate = Gate()
        await transport.hold(with: gate)
        try await queue.enqueue(save([setRow(1)]), for: session)
        let a = Task { [session] in await queue.flush(session) }
        while await transport.count == 0 { await Task.yield() }
        let b = Task { [session] in await queue.flush(session) }
        try await queue.enqueue(save([setRow(2)]), for: session)
        await gate.open()
        await a.value
        await b.value
        // Two ops, two sends, no duplicate of either.
        let v45 = await transport.requests.map(\.action)
        XCTAssertEqual(v45, ["save", "save"])
    }

    func testUntilIdleWaitsOutTheFlushThatPicksUpALateOp() async throws {
        // The tracker's finish: a save is in the air when the finish is queued
        // and flushed. That flush returns at once; `untilIdle` is what waits
        // for the running one to send what was queued behind its save.
        let transport = ScriptedTransport()
        let queue = makeQueue(transport)
        let gate = Gate()
        await transport.hold(with: gate)
        try await queue.enqueue(save([setRow(1)]), for: session)
        let first = Task { [session] in await queue.flush(session) }
        while await transport.count == 0 { await Task.yield() }
        try await queue.enqueue(save([setRow(2)]), for: session)
        await queue.flush(session)
        let returned = Gate()
        let idle = Task { [session] in
            await queue.untilIdle(session)
            await returned.open()
            return await transport.requests.map(\.action)
        }
        await waitFor(1, "untilIdle parked") { await queue.idleWaiterCount(for: session) }
        let early = await returned.isOpen
        XCTAssertFalse(early, "returned while the first save was still in the air")
        await gate.open()
        let sent = await idle.value
        await first.value
        XCTAssertEqual(sent, ["save", "save"])
        await queue.untilIdle(session)  // idle already: returns at once
    }

    /// Holds the `held`-th `nextPending` read after it has read the store, so
    /// it answers what the store held before the gate.
    private actor StaleReadStore: WriteQueueStore {
        let inner = MemoryWriteQueueStore()
        let gate: Gate
        let held: Int
        private(set) var reads = 0
        init(holdingRead held: Int, on gate: Gate) { self.held = held; self.gate = gate }
        func nextPending(for session: SessionKey) async throws -> TrackerOp? {
            reads += 1
            let answer = try await inner.nextPending(for: session)
            if reads == held { await gate.wait() }
            return answer
        }
        func append(_ op: TrackerOp) async throws -> Int64 { try await inner.append(op) }
        func update(_ op: TrackerOp) async throws -> Bool { try await inner.update(op) }
        func delete(id: Int64) async throws { try await inner.delete(id: id) }
        func tail(for session: SessionKey) async throws -> TrackerOp? { try await inner.tail(for: session) }
        func ops(for session: SessionKey) async throws -> [TrackerOp] { try await inner.ops(for: session) }
        func sessionsWithPending() async throws -> [SessionKey] { try await inner.sessionsWithPending() }
        func purge(session: SessionKey) async throws { try await inner.purge(session: session) }
        func purgeAll() async throws { try await inner.purgeAll() }
    }

    func testUntilIdleWaitsForTheRerunPassAnOpQueuedAfterTheLastReadNeeds() async throws {
        // The narrow case: the running flush has sent everything and is reading
        // an empty queue when the finish is queued. The enqueue waits for that
        // read (the lane's turn) and lands after it, so only the re-run sends
        // it, and `untilIdle` must not return before that pass.
        let transport = ScriptedTransport()
        let gate = Gate()
        let store = StaleReadStore(holdingRead: 2, on: gate)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        try await queue.enqueue(save([setRow(1)]), for: session)
        let first = Task { [session] in await queue.flush(session) }
        while await store.reads < 2 { await Task.yield() }   // sent op 1, read empty, held
        let edit = save([setRow(2)])
        let queued = Task { [session] in try await queue.enqueue(edit, for: session) }
        await waitForTurnWaiters(1, on: queue, in: session)   // the enqueue waits for that read
        await queue.flush(session)                            // mid-flush: asks for a re-run
        let idle = Task { [session] in
            await queue.untilIdle(session)
            return await transport.requests.map(\.action)
        }
        await waitFor(1, "untilIdle parked") { await queue.idleWaiterCount(for: session) }
        await gate.open()
        let sent = await idle.value
        _ = try await queued.value
        await first.value
        XCTAssertEqual(sent, ["save", "save"])
    }

    // MARK: - Enqueue order

    /// Holds the `held`-th `tail(for:)` read after it has read the store, so
    /// the enqueue that made it answers what the store held before the gate.
    /// The GRDB store's read is a real suspension and the queue is reentrant:
    /// this is that suspension, made long enough to queue something behind.
    private actor HeldTailStore: WriteQueueStore {
        let inner = MemoryWriteQueueStore()
        let gate: Gate
        let held: Int
        private(set) var tails = 0
        init(holdingTail held: Int = 1, on gate: Gate) { self.held = held; self.gate = gate }
        func tail(for session: SessionKey) async throws -> TrackerOp? {
            tails += 1
            let answer = try await inner.tail(for: session)
            if tails == held { await gate.wait() }
            return answer
        }
        func append(_ op: TrackerOp) async throws -> Int64 { try await inner.append(op) }
        func update(_ op: TrackerOp) async throws -> Bool { try await inner.update(op) }
        func delete(id: Int64) async throws { try await inner.delete(id: id) }
        func nextPending(for session: SessionKey) async throws -> TrackerOp? { try await inner.nextPending(for: session) }
        func ops(for session: SessionKey) async throws -> [TrackerOp] { try await inner.ops(for: session) }
        func sessionsWithPending() async throws -> [SessionKey] { try await inner.sessionsWithPending() }
        func purge(session: SessionKey) async throws { try await inner.purge(session: session) }
        func purgeAll() async throws { try await inner.purgeAll() }
        func all() async -> [TrackerOp] { await inner.all }
    }

    func testAnOpQueuedWhileASaveReadsTheTailLandsBehindTheSave() async throws {
        // The tracker's Finish or Swap tapped as the autosave fires: the save
        // is inside `enqueue`, waiting on its tail read, when the finish is
        // queued. The finish must not take the lower id — the server would
        // build the recap and PRs without the last set, and a swap would be
        // overwritten by the save carrying the old name.
        let behind: [TrackerOpPayload] = [
            .finish(FinishPayload(autofillRows: [], finishedAt: nil)),
            .swapExercise(SwapPayload(section: "exercise", exerciseId: "fx-press", exerciseName: "Fixture Bench", definitionId: "fixture-bench")),
        ]
        for payload in behind {
            let transport = ScriptedTransport()
            let gate = Gate()
            let store = HeldTailStore(on: gate)
            let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
            let edit = save([setRow(1)])
            let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
            while await store.tails < 1 { await Task.yield() }   // the save holds its tail read
            let queuing = Task { [session] in try await queue.enqueue(payload, for: session) }
            await waitForTurnWaiters(1, on: queue, in: session)
            await gate.open()
            _ = try await saving.value
            _ = try await queuing.value

            let stored = await store.all().map(\.payload.action)
            XCTAssertEqual(stored, [.save, payload.action])
            await queue.flush(session)
            let sent = await transport.requests.map(\.action)
            XCTAssertEqual(sent, ["save", payload.action.rawValue])
        }
    }

    func testOpsWaitingBehindASaveLandInTheOrderTheyWereQueued() async throws {
        // Two callers wait for the lane at once: the turn passes first come,
        // first served, not to whoever asked last.
        let gate = Gate()
        let store = HeldTailStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        let edit = save([setRow(1)])
        let finish = TrackerOpPayload.finish(FinishPayload(autofillRows: [], finishedAt: nil))
        let swap = TrackerOpPayload.swapExercise(SwapPayload(section: "exercise", exerciseId: "fx-press", exerciseName: "Fixture Bench", definitionId: "fixture-bench"))
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await store.tails < 1 { await Task.yield() }
        let finishing = Task { [session] in try await queue.enqueue(finish, for: session) }
        await waitForTurnWaiters(1, on: queue, in: session)   // the finish is asked for first
        let swapping = Task { [session] in try await queue.enqueue(swap, for: session) }
        await waitForTurnWaiters(2, on: queue, in: session)
        await gate.open()
        _ = try await saving.value
        _ = try await finishing.value
        _ = try await swapping.value

        let stored = await store.all().map(\.payload.action)
        XCTAssertEqual(stored, [.save, .finish, .swapExercise])
    }

    func testACancelQueuedWhileASaveReadsTheTailLeavesNothingBehindIt() async throws {
        // Nothing queued for a cancelled session may land after the cancel:
        // a save already inside `enqueue` is queued first and purged with it.
        let gate = Gate()
        let store = HeldTailStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        let edit = save([setRow(1)])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await store.tails < 1 { await Task.yield() }
        let cancelling = Task { [session] in try await queue.cancelSession(session) }
        await waitForTurnWaiters(1, on: queue, in: session)
        await gate.open()
        _ = try await saving.value
        try await cancelling.value

        let stored = await store.all().map(\.payload)
        XCTAssertEqual(stored, [.cancel])
    }

    func testASaveWhoseTailWasSentDuringTheReadIsNotLost() async throws {
        // The save reads the tail while that tail is in the air; the send
        // lands and the row is deleted before the read returns. Merging into
        // the row it read would write into nothing.
        let transport = ScriptedTransport()
        let sending = Gate()
        await transport.hold(with: sending)
        let reading = Gate()
        let store = HeldTailStore(holdingTail: 2, on: reading)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        try await queue.enqueue(save([setRow(1, weight: "100")]), for: session)
        let flush = Task { [session] in await queue.flush(session) }
        while await transport.count == 0 { await Task.yield() }   // the first save is in the air
        let edit = save([setRow(2, weight: "105")])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await store.tails < 2 { await Task.yield() }       // the second holds its tail read
        await sending.open()
        // The send lands; its settle waits for the save's turn, so the row stays.
        await waitForTurnWaiters(1, on: queue, in: session)
        let rows = await store.all().count
        XCTAssertEqual(rows, 1, "settled while the save held the lane")
        await reading.open()
        _ = try await saving.value
        await flush.value

        await queue.flush(session)
        let weights = await transport.requests.flatMap { ($0.body?["setLogs"] as? [[String: Any]] ?? []).compactMap { $0["actual_weight"] as? String } }
        XCTAssertEqual(weights, ["100", "105"])
    }

    func testASaveQueuedWhileTheDrainReadsItsNextOpIsNotMergedIntoWhatItSends() async throws {
        // The drain has read the tail save and not yet marked it in flight. A
        // save merged into that row now is not in what the drain sends, and
        // goes when the drain deletes the row.
        let transport = ScriptedTransport()
        let gate = Gate()
        let store = StaleReadStore(holdingRead: 1, on: gate)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        try await queue.enqueue(save([setRow(1, weight: "100")]), for: session)
        let flush = Task { [session] in await queue.flush(session) }
        while await store.reads < 1 { await Task.yield() }   // the drain holds its read of the first save
        let edit = save([setRow(2, weight: "105")])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        await waitForTurnWaiters(1, on: queue, in: session)
        await gate.open()
        _ = try await saving.value
        await flush.value

        await queue.flush(session)
        let weights = await transport.requests.flatMap { ($0.body?["setLogs"] as? [[String: Any]] ?? []).compactMap { $0["actual_weight"] as? String } }
        XCTAssertEqual(weights, ["100", "105"])
    }

    func testAPurgeTakesASaveThatWasAlreadyBeingQueued() async throws {
        // Account deletion purges the store while the autosave's save waits on
        // its tail read. The save goes with everything else: appended after
        // the purge, it would 404 forever for an account that no longer exists.
        let gate = Gate()
        let store = HeldTailStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        let edit = save([setRow(1)])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await store.tails < 1 { await Task.yield() }
        await queue.purgeAll()
        await gate.open()
        let returned = try await saving.value

        let left = await store.all()
        XCTAssertEqual(left, [])
        XCTAssertEqual(returned.id, 0, "handed back unstored")
    }

    func testAPurgeTakesASaveThatReadAPendingSaveBeforeIt() async throws {
        // The save read the lane's pending save as its merge target; the purge
        // removes that row before the merge is written. Neither the merge nor
        // its fallback append may bring the session back.
        let gate = Gate()
        let store = HeldTailStore(holdingTail: 2, on: gate)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        try await queue.enqueue(save([setRow(1, weight: "100")]), for: session)
        let edit = save([setRow(2, weight: "105")])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await store.tails < 2 { await Task.yield() }   // read the first save, held
        await queue.purgeAll()
        await gate.open()
        _ = try await saving.value

        let left = await store.all()
        XCTAssertEqual(left, [])
    }

    /// Holds the first `append` after `arm()` before it inserts: the write
    /// has left the queue but not reached the database.
    private actor HeldAppendStore: WriteQueueStore {
        let inner = MemoryWriteQueueStore()
        let gate: Gate
        private var armed = false
        private(set) var isHolding = false
        init(on gate: Gate) { self.gate = gate }
        func arm() { armed = true }
        func append(_ op: TrackerOp) async throws -> Int64 {
            if armed {
                armed = false
                isHolding = true
                await gate.wait()
            }
            return try await inner.append(op)
        }
        func tail(for session: SessionKey) async throws -> TrackerOp? { try await inner.tail(for: session) }
        func update(_ op: TrackerOp) async throws -> Bool { try await inner.update(op) }
        func delete(id: Int64) async throws { try await inner.delete(id: id) }
        func nextPending(for session: SessionKey) async throws -> TrackerOp? { try await inner.nextPending(for: session) }
        func ops(for session: SessionKey) async throws -> [TrackerOp] { try await inner.ops(for: session) }
        func sessionsWithPending() async throws -> [SessionKey] { try await inner.sessionsWithPending() }
        func purge(session: SessionKey) async throws { try await inner.purge(session: session) }
        func purgeAll() async throws { try await inner.purgeAll() }
        func all() async -> [TrackerOp] { await inner.all }
    }

    func testAPurgeThatOvertakesTheInsertStillLeavesNothing() async throws {
        // The save passed its purge check and its insert is on the way when
        // the purge's delete gets to the database first.
        let gate = Gate()
        let store = HeldAppendStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        await store.arm()
        let edit = save([setRow(1)])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await !store.isHolding { await Task.yield() }
        await queue.purgeAll()
        await gate.open()
        let returned = try await saving.value

        let left = await store.all()
        XCTAssertEqual(left, [])
        XCTAssertEqual(returned.id, 0)
    }

    func testACancelUnderWayWhenThePurgeRunsQueuesNothing() async throws {
        let gate = Gate()
        let store = HeldTailStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        let edit = save([setRow(1)])
        let saving = Task { [session] in try await queue.enqueue(edit, for: session) }
        while await store.tails < 1 { await Task.yield() }
        let cancelling = Task { [session] in try await queue.cancelSession(session) }
        await waitForTurnWaiters(1, on: queue, in: session)   // called before the purge, waiting behind the save
        await queue.purgeAll()
        await gate.open()
        _ = try await saving.value
        try await cancelling.value

        let left = await store.all()
        XCTAssertEqual(left, [])
    }

    /// Answers the tail with a pending save that is no longer stored: a row
    /// removed between the merge's read and its write.
    private actor GoneTailStore: WriteQueueStore {
        let inner = MemoryWriteQueueStore()
        let gone: TrackerOp
        init(gone: TrackerOp) { self.gone = gone }
        func tail(for session: SessionKey) async throws -> TrackerOp? { gone }
        func append(_ op: TrackerOp) async throws -> Int64 { try await inner.append(op) }
        func update(_ op: TrackerOp) async throws -> Bool { try await inner.update(op) }
        func delete(id: Int64) async throws { try await inner.delete(id: id) }
        func nextPending(for session: SessionKey) async throws -> TrackerOp? { try await inner.nextPending(for: session) }
        func ops(for session: SessionKey) async throws -> [TrackerOp] { try await inner.ops(for: session) }
        func sessionsWithPending() async throws -> [SessionKey] { try await inner.sessionsWithPending() }
        func purge(session: SessionKey) async throws { try await inner.purge(session: session) }
        func purgeAll() async throws { try await inner.purgeAll() }
        func all() async -> [TrackerOp] { await inner.all }
    }

    func testASaveWhoseMergeTargetIsGoneIsAppendedNotLost() async throws {
        let gone = TrackerOp(id: 999, session: session, payload: save([setRow(1, weight: "100")]), createdAt: Date(timeIntervalSince1970: 1_788_868_800))
        let store = GoneTailStore(gone: gone)
        let queue = WriteQueue(store: store, client: makeClient(ScriptedTransport()), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        try await queue.enqueue(save([setRow(2, weight: "105")]), for: session)

        let stored = await store.all().map(\.payload)
        XCTAssertEqual(stored, [save([setRow(2, weight: "105")])])
    }

    /// Holds the first `ops(for:)` read after `arm()` once it has read the
    /// store, so the caller answers what the lane held before the gate.
    private actor HeldOpsStore: WriteQueueStore {
        let inner = MemoryWriteQueueStore()
        let gate: Gate
        private var armed = false
        private(set) var isHolding = false
        init(on gate: Gate) { self.gate = gate }
        func arm() { armed = true }
        func ops(for session: SessionKey) async throws -> [TrackerOp] {
            let answer = try await inner.ops(for: session)
            if armed {
                armed = false
                isHolding = true
                await gate.wait()
            }
            return answer
        }
        func tail(for session: SessionKey) async throws -> TrackerOp? { try await inner.tail(for: session) }
        func append(_ op: TrackerOp) async throws -> Int64 { try await inner.append(op) }
        func update(_ op: TrackerOp) async throws -> Bool { try await inner.update(op) }
        func delete(id: Int64) async throws { try await inner.delete(id: id) }
        func nextPending(for session: SessionKey) async throws -> TrackerOp? { try await inner.nextPending(for: session) }
        func sessionsWithPending() async throws -> [SessionKey] { try await inner.sessionsWithPending() }
        func purge(session: SessionKey) async throws { try await inner.purge(session: session) }
        func purgeAll() async throws { try await inner.purgeAll() }
    }

    private let oats = MealOpPayload(kind: .create, id: "meal-oats", title: "Oats", day: "2026-09-08", columns: [:])

    func testALetGoMadeWhileAFlushPutsTheOpBackIsNotUndone() async throws {
        // A flush reads the lane to put its gave-up ops back while the user
        // lets one go. Written from that earlier read, the put-back would
        // turn the let-go meal pending again, and send it.
        let transport = ScriptedTransport()
        let gate = Gate()
        let store = HeldOpsStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        var meal = try await queue.enqueue(.meal(oats), for: .outbox)
        meal.state = .failed
        meal.gaveUp = true
        meal.giveUpCount = TrackerOp.letGoThreshold
        _ = try await store.update(meal)

        await store.arm()
        let flushing = Task { await queue.flush() }
        while await !store.isHolding { await Task.yield() }   // the put-back holds its read
        let id = meal.id
        let lettingGo = Task { await queue.letGo(id, in: .outbox) }
        await waitForTurnWaiters(1, on: queue, in: .outbox)   // tapped before the put-back writes
        await gate.open()
        await flushing.value
        let letGo = await lettingGo.value
        await queue.flush(.outbox)

        XCTAssertEqual(letGo, .meal(oats))
        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, [], "a let-go meal is never sent")
        let kept = await queue.ops(for: .outbox)
        XCTAssertEqual(kept.map(\.isRefused), [true])
    }

    func testALetGoDuringASendTakesEffectWhenTheSendFails() async throws {
        // The send's outcome is written over the op, so a let-go written
        // during it would be undone the moment the send failed. It waits for
        // the send instead, then lets go of what is still waiting.
        let transport = ScriptedTransport([.status(500, body: "boom"), .ok()])
        let gate = Gate()
        await transport.hold(with: gate)
        let store = MemoryWriteQueueStore()
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock)
        var meal = try await queue.enqueue(.meal(oats), for: .outbox)
        meal.giveUpCount = TrackerOp.letGoThreshold   // put back after three give-ups
        try await store.update(meal)
        let flushing = Task { await queue.flush(.outbox) }
        while await transport.count == 0 { await Task.yield() }

        let id = meal.id
        let lettingGo = Task { await queue.letGo(id, in: .outbox) }
        await waitFor(1, "let-go parked on the send") { await queue.settleWaiterCount(for: id) }
        await gate.open()
        await flushing.value
        let letGo = await lettingGo.value

        XCTAssertEqual(letGo, .meal(oats))
        let kept = await store.all.map(\.isRefused)
        XCTAssertEqual(kept, [true], "kept as a refusal, not back waiting")
        clock.open()
        await queue.awaitRetries()
        let sent = await transport.count
        XCTAssertEqual(sent, 1, "the retry found nothing to send")
    }

    func testALetGoWaitsOutASecondSendWhenTheOpIsPickedAgainAtOnce() async throws {
        // The network comes back during the first send, so its failure is
        // re-sent at once: the drain picks the op again before the waiting
        // let-go gets the lane. It must wait out that send too, or the second
        // send's outcome is written over the let-go.
        let transport = ScriptedTransport([.throwNetwork, .throwNetwork, .ok()])
        let first = Gate()
        await transport.hold(with: first)
        let picking = Gate()
        let store = HeldOpsStore(on: picking)
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        var meal = try await queue.enqueue(.meal(oats), for: .outbox)
        meal.giveUpCount = TrackerOp.letGoThreshold
        _ = try await store.update(meal)
        let flushing = Task { await queue.flush(.outbox) }
        while await transport.count == 0 { await Task.yield() }

        let id = meal.id
        let returned = Gate()
        let lettingGo = Task {
            let payload = await queue.letGo(id, in: .outbox)
            await returned.open()
            return payload
        }
        await waitFor(1, "let-go parked on the first send") { await queue.settleWaiterCount(for: id) }
        let second = Gate()
        await transport.hold(with: second)
        await queue.resume()                                  // mid-send: the failure is re-sent at once
        await store.arm()                                     // the next lane read is the drain's re-pick
        await first.open()
        // The first send settles and wakes the let-go, but the drain has
        // already taken the lane to pick the op again: the let-go waits for it.
        await waitForTurnWaiters(1, on: queue, in: .outbox)
        await picking.open()
        // Picked again and in the air when the turn reaches the let-go: it
        // waits out this send too.
        await waitFor(1, "let-go parked on the second send") { await queue.settleWaiterCount(for: id) }
        let early = await returned.isOpen
        XCTAssertFalse(early, "let go while the second send was in the air")
        await second.open()
        await flushing.value
        let letGo = await lettingGo.value

        XCTAssertEqual(letGo, .meal(oats))
        let kept = await queue.ops(for: .outbox).map(\.isRefused)
        XCTAssertEqual(kept, [true])
        let sent = await transport.count
        XCTAssertEqual(sent, 2)
        clock.open()
        await queue.awaitRetries()
    }

    func testALetGoDuringASendThatLandsLetsNothingGo() async throws {
        let transport = ScriptedTransport()
        let gate = Gate()
        await transport.hold(with: gate)
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        var meal = try await queue.enqueue(.meal(oats), for: .outbox)
        meal.giveUpCount = TrackerOp.letGoThreshold
        try await store.update(meal)
        let flushing = Task { await queue.flush(.outbox) }
        while await transport.count == 0 { await Task.yield() }

        let id = meal.id
        let lettingGo = Task { await queue.letGo(id, in: .outbox) }
        await waitFor(1, "let-go parked on the send") { await queue.settleWaiterCount(for: id) }
        await gate.open()
        await flushing.value
        let letGo = await lettingGo.value

        XCTAssertNil(letGo, "it landed: nothing to let go, nothing to undo")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    // Two taps on the tracker's failure bar, Discard and Retry, a moment
    // apart: the first one tapped decides.

    func testDiscardTappedJustBeforeRetryWins() async throws {
        let transport = ScriptedTransport()
        let gate = Gate()
        let store = HeldOpsStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        var failed = try await queue.enqueue(save([setRow(1)]), for: session)
        failed.state = .failed
        _ = try await store.update(failed)

        await store.arm()
        let discarding = Task { [session] in await queue.discardFailed(session) }
        while await !store.isHolding { await Task.yield() }
        let retrying = Task { [session] in await queue.retryFailed(session) }
        await waitForTurnWaiters(1, on: queue, in: session)
        await gate.open()
        await discarding.value
        await retrying.value

        let sent = await transport.count
        XCTAssertEqual(sent, 0, "discarded, so never sent")
        let left = await queue.ops(for: session)
        XCTAssertEqual(left, [])
    }

    func testRetryTappedJustBeforeDiscardWins() async throws {
        let transport = ScriptedTransport()
        let gate = Gate()
        let store = HeldOpsStore(on: gate)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: TestClock(now: Date(timeIntervalSince1970: 1_788_868_800)))
        var failed = try await queue.enqueue(save([setRow(1)]), for: session)
        failed.state = .failed
        _ = try await store.update(failed)

        await store.arm()
        let retrying = Task { [session] in await queue.retryFailed(session) }
        while await !store.isHolding { await Task.yield() }
        let discarding = Task { [session] in await queue.discardFailed(session) }
        await waitForTurnWaiters(1, on: queue, in: session)
        await gate.open()
        await retrying.value
        await discarding.value
        await queue.untilIdle(session)

        let sent = await transport.requests.map(\.action)
        XCTAssertEqual(sent, ["save"], "retried, so sent")
    }

    // MARK: - The outbox lane (an exercise created offline outside a workout)

    private let pancake = DefinitionCreatePayload(id: "pancake-fold", canonicalName: "Pancake Fold", category: "stretch", isUnilateral: false)

    func testALibraryCreateWaitsOutAnOutageLongerThanTheCeiling() async throws {
        // Five failed sends against a two-attempt ceiling: a tracker op would
        // have failed at the third; the library create keeps waiting and lands.
        let transport = ScriptedTransport([.throwNetwork, .throwNetwork, .throwNetwork, .throwNetwork, .throwNetwork, .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 2))
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)

        await queue.flush(.outbox)
        await queue.awaitRetries()

        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, Array(repeating: "/api/exercise-definitions", count: 6))
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testALibraryCreateStillFailsOnAServerError() async throws {
        let transport = ScriptedTransport([.status(500, body: "boom"), .status(500, body: "boom"), .status(500, body: "boom")])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 2))
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)

        await queue.flush(.outbox)
        await queue.awaitRetries()

        let remaining = await store.all.map(\.state)
        XCTAssertEqual(remaining, [.failed], "only the network is waited out")
    }

    func testResumeSendsALibraryCreateWithoutWaitingOutItsBackoff() async throws {
        let transport = ScriptedTransport([.throwNetwork, .ok()])
        let store = MemoryWriteQueueStore()
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)

        await queue.flush(.outbox)
        let first = await transport.requests.count
        XCTAssertEqual(first, 1, "offline: one try, then a backoff the held clock never ends")

        // The network is back: the create goes now, not when the backoff ends.
        await queue.resume()
        let sent = await transport.requests.count
        XCTAssertEqual(sent, 2)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        // The called-off retry is still parked on the held clock (a cancelled
        // HeldClock sleep ends only at open()): release it so it winds down.
        clock.open()
        await queue.awaitRetries()
    }

    func testPendingCreatesAreReadAcrossSessions() async throws {
        let transport = ScriptedTransport([.throwNetwork])
        let queue = makeQueue(transport, clock: HeldClock())
        let couch = DefinitionCreatePayload(id: "couch-stretch", canonicalName: "Couch Stretch", category: "stretch", isUnilateral: false)
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)
        try await queue.enqueue(.createDefinition(couch), for: session)
        try await queue.enqueue(save([setRow(1)]), for: session)

        let pending = await queue.pendingDefinitionCreates().map(\.id).sorted()
        XCTAssertEqual(pending, ["couch-stretch", "pancake-fold"])
    }

    // MARK: - A Builder save in the outbox

    private func draftSave(_ title: String) -> TrackerOpPayload {
        .workoutDraft(WorkoutDraftOpPayload(
            draft: .empty(date: "2026-09-10", title: title), today: "2026-09-08", action: .create,
            clientId: "ai-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90"
        ))
    }

    func testASaveTheServerAcceptsLeavesTheOutbox() async throws {
        let transport = ScriptedTransport([.ok(#"{"ok":true,"action":"create","id":"ai-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90"}"#)])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(draftSave("Leg day"), for: .outbox)
        await queue.flush(.outbox)
        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, ["/api/workout-draft"])
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testASaveTheServerRefusesOnValidationIsKeptAsFailedWithItsReason() async throws {
        // 200 with ok:false is a refusal, not a success: nothing was written.
        let transport = ScriptedTransport([.ok(#"{"ok":false,"problem":"Per-side counts needed for unilateral exercises"}"#)])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(draftSave("Leg day"), for: .outbox)
        await queue.flush(.outbox)

        let kept = await queue.ops(for: .outbox)
        XCTAssertEqual(kept.map(\.state), [.failed])
        XCTAssertEqual(kept.first?.lastError, "Per-side counts needed for unilateral exercises")
        let failure = QueueEvent.failed(.outbox, .workoutDraft, "Per-side counts needed for unilateral exercises")
        let events = await recorder.waitFor { $0.contains(failure) }
        XCTAssertTrue(events.contains(failure))
        await recorder.stop()

        await queue.discard(kept[0].id, in: .outbox)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testAResumeDuringAFailingOutboxSendStillSendsAtOnce() async throws {
        // The send is in the air with no signal when the network comes back:
        // its failure must not re-close the gate resume() just opened.
        let transport = ScriptedTransport([.throwNetwork, .ok()])
        let gate = Gate()
        await transport.hold(with: gate)
        let store = MemoryWriteQueueStore()
        let clock = HeldClock()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)

        let first = Task { await queue.flush(.outbox) }
        while await transport.requests.isEmpty { await Task.yield() }
        await queue.resume()          // finds the flush running: it only asks for a re-run
        await gate.open()             // the in-flight send now fails on the network
        await first.value

        let sent = await transport.requests.count
        XCTAssertEqual(sent, 2, "retried at once, not after a backoff the held clock never ends")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        clock.open()
        await queue.awaitRetries()
    }

    // MARK: - A calendar toggle in the outbox (completion, then its plan-fill)

    private let occurrence = SessionKey(eventId: "ios-fixture-run", eventDate: "2026-09-08")

    private func toggle(complete: Bool) -> (completion: TrackerOpPayload, quick: TrackerOpPayload) {
        let completionRow = CompletionRow(
            eventId: occurrence.eventId, eventDate: occurrence.eventDate, eventType: "cardio", eventTitle: "Fixture Run",
            durationMinutes: 45, isCompleted: complete, completedAt: complete ? "2026-09-08T12:00:00.000Z" : nil
        )
        let logRow = CompletionLogRow(
            eventId: occurrence.eventId, eventDate: occurrence.eventDate, eventType: "cardio", eventTitle: "Fixture Run",
            durationMinutes: 45, action: complete ? "complete" : "uncomplete", clientToggleId: "0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90"
        )
        return (
            .completion(completionRow: completionRow, logRow: logRow),
            .quickComplete(QuickCompletePayload(eventId: occurrence.eventId, eventDate: occurrence.eventDate, isCompleting: complete))
        )
    }

    func testAToggleQueuedOfflineWaitsOutTheOutageAndLandsInOrder() async throws {
        // Three failed sends against a two-attempt ceiling: a tracker op would
        // have failed; the toggle keeps waiting, then the plan-fill follows it.
        let transport = ScriptedTransport([.throwNetwork, .throwNetwork, .throwNetwork, .ok(), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 2))
        let ops = toggle(complete: true)
        try await queue.enqueue(ops.completion, for: .outbox)
        try await queue.enqueue(ops.quick, for: .outbox)

        await queue.flush(.outbox)
        await queue.awaitRetries()

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), Array(repeating: "/api/completions", count: 4) + ["/api/workout-sessions"])
        let completion = requests[3].body?["completionRow"] as? [String: Any]
        XCTAssertEqual(completion?["event_id"] as? String, "ios-fixture-run")
        XCTAssertEqual(completion?["is_completed"] as? Bool, true)
        let log = requests[3].body?["logRow"] as? [String: Any]
        XCTAssertEqual(log?["action"] as? String, "complete")
        XCTAssertEqual(log?["client_toggle_id"] as? String, "0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90", "every replay carries the one id")
        // The plan-fill names the occurrence, not the lane it waited in.
        XCTAssertEqual(requests[4].action, "quick-complete")
        XCTAssertEqual(requests[4].body?["eventId"] as? String, "ios-fixture-run")
        XCTAssertEqual(requests[4].body?["eventDate"] as? String, "2026-09-08")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testAnUndoQueuesTheUncompleteAndItsClearing() async throws {
        let transport = ScriptedTransport()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let ops = toggle(complete: false)
        try await queue.enqueue(ops.completion, for: .outbox)
        try await queue.enqueue(ops.quick, for: .outbox)
        await queue.flush(.outbox)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/completions", "/api/workout-sessions"])
        XCTAssertEqual((requests[0].body?["logRow"] as? [String: Any])?["action"] as? String, "uncomplete")
        XCTAssertEqual(requests[1].action, "quick-uncomplete")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testARefusedCompletionIsReportedWithItsActionAndKept() async throws {
        // A 4xx is final: the completion is kept as failed (a refusal, not a
        // give-up) and named in the event, so the schedule can undo its
        // optimistic flip. The plan-fill queued behind it goes with it, unsent.
        let transport = ScriptedTransport([.status(400, body: "Invalid action"), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        let ops = toggle(complete: true)
        try await queue.enqueue(ops.completion, for: .outbox)
        try await queue.enqueue(ops.quick, for: .outbox)
        await queue.flush(.outbox)

        let failure = QueueEvent.failed(.outbox, .completion, "Invalid action")
        let events = await recorder.waitFor { $0.contains(failure) }
        XCTAssertTrue(events.contains(failure))
        await recorder.stop()
        let kept = await store.all
        XCTAssertEqual(kept.map(\.state), [.failed])
        XCTAssertEqual(kept.first?.payload.action, .completion)
        XCTAssertEqual(kept.first?.isRefused, true)
        XCTAssertEqual(kept.first?.isWaiting, false)
        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, ["/api/completions"], "the quick-complete behind a refused completion is never sent")
    }

    func testARefusedCompletionRetiresOnlyItsOwnQuickComplete() async throws {
        // Two toggles queued offline; the first's completion is refused. Its
        // plan-fill is retired with it; the second toggle lands whole.
        let transport = ScriptedTransport([.status(400, body: "Invalid action"), .ok(), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let first = toggle(complete: true)
        let second = SessionKey(eventId: "ios-fixture-weekly__2026-09-22", eventDate: "2026-09-22")
        try await queue.enqueue(first.completion, for: .outbox)
        try await queue.enqueue(first.quick, for: .outbox)
        try await queue.enqueue(.completion(
            completionRow: CompletionRow(eventId: second.eventId, eventDate: second.eventDate, eventType: "strength", eventTitle: "Press",
                                         durationMinutes: nil, isCompleted: true, completedAt: "2026-09-22T12:00:00.000Z"),
            logRow: CompletionLogRow(eventId: second.eventId, eventDate: second.eventDate, eventType: "strength", eventTitle: "Press",
                                     durationMinutes: nil, action: "complete", clientToggleId: "1b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90")
        ), for: .outbox)
        try await queue.enqueue(.quickComplete(QuickCompletePayload(eventId: second.eventId, eventDate: second.eventDate, isCompleting: true)), for: .outbox)
        await queue.flush(.outbox)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/completions", "/api/completions", "/api/workout-sessions"])
        XCTAssertEqual(requests[2].body?["eventId"] as? String, second.eventId)
        let kept = await store.all
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept.first?.isRefused, true)
    }

    func testARefusedCompletionLeavesALaterToggleOfTheSameOccurrenceWhole() async throws {
        // Complete then undo, both offline; the completion is refused. Only
        // its own plan-fill goes with it — the undo and *its* plan-fill land.
        let transport = ScriptedTransport([.status(400, body: "Invalid action"), .ok(), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let complete = toggle(complete: true)
        let undo = toggle(complete: false)
        try await queue.enqueue(complete.completion, for: .outbox)
        try await queue.enqueue(complete.quick, for: .outbox)
        try await queue.enqueue(undo.completion, for: .outbox)
        try await queue.enqueue(undo.quick, for: .outbox)
        await queue.flush(.outbox)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/completions", "/api/completions", "/api/workout-sessions"])
        XCTAssertEqual((requests[1].body?["logRow"] as? [String: Any])?["action"] as? String, "uncomplete")
        XCTAssertEqual(requests[2].action, "quick-uncomplete")
        let kept = await store.all
        XCTAssertEqual(kept.map(\.payload.action), [.completion])
        XCTAssertEqual(kept.first?.isRefused, true)
    }

    func testAHeadTheServerAlwaysFailsCountsItsGiveUpsAndCanBeLetGo() async throws {
        // A deterministic 500 (a row the server will never take): every
        // resume puts the head back and it gives up again, the meal behind
        // it never moves. The count climbs to the let-go threshold; letting
        // the head go frees the lane and the next flush sends the rest.
        let transport = ScriptedTransport([.status(500, body: "boom")])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 1))
        let ops = toggle(complete: true)
        try await queue.enqueue(ops.completion, for: .outbox)
        try await queue.enqueue(ops.quick, for: .outbox)
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        await queue.resume()
        await queue.awaitRetries()
        await queue.resume()
        await queue.awaitRetries()

        let held = await store.all
        XCTAssertEqual(held.map(\.payload.action), [.completion, .quickComplete, .meal])
        XCTAssertEqual(held.first?.giveUpCount, 3)
        XCTAssertEqual(held.first?.canLetGo, true)
        XCTAssertEqual(held.map(\.canLetGo), [true, false, false])
        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, Array(repeating: "/api/completions", count: 6), "two tries per give-up; nothing behind the head moved")

        await transport.script([.ok()])
        let letGo = await queue.letGo(held[0].id, in: .outbox)
        XCTAssertEqual(letGo?.action, .completion)
        let after = await store.all.map(\.payload.action)
        XCTAssertEqual(after, [.meal], "the completion and its own plan-fill are gone, unsent")
        await queue.flush(.outbox)
        let paths = await transport.requests.map(\.path)
        XCTAssertEqual(paths.suffix(1), ["/api/meals"], "the meal behind the let-go head lands on the next flush")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testLetGoRefusesAnOpNotYetGivenUpOnEnough() async throws {
        let transport = ScriptedTransport([.status(500, body: "boom")])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        let held = await store.all
        XCTAssertEqual(held.first?.giveUpCount, 1)
        let letGo = await queue.letGo(held[0].id, in: .outbox)
        XCTAssertNil(letGo, "one give-up is Retry's business, not Let go's")
        let left = await store.all.count
        XCTAssertEqual(left, 1)
    }

    func testAGiveUpOnTheRateLimitDoesNotCountTowardLetGo() async throws {
        // Three 429s past the ceiling: the create waits like any give-up,
        // but the server's write cap says nothing about the row, so the
        // count stays at zero and Let go is never offered for it. Three
        // 500s on the same op count as they always did.
        let transport = ScriptedTransport([.status(429, headers: ["Retry-After": "7"])])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)
        for _ in 0..<3 {
            await queue.resume()
            await queue.awaitRetries()
        }
        var held = await store.all
        XCTAssertEqual(held.map(\.gaveUp), [true], "still waiting")
        XCTAssertEqual(held.first?.giveUpCount, 0)
        XCTAssertEqual(held.first?.canLetGo, false)
        XCTAssertTrue(RetryPolicy.isRateLimitGiveUp(held.first?.lastError ?? ""), "the keeps-trying toast can name the rate limit")
        let sent = await transport.requests.count
        XCTAssertEqual(sent, 3)

        await transport.script([.status(500, body: "boom")])
        for _ in 0..<3 {
            await queue.resume()
            await queue.awaitRetries()
        }
        held = await store.all
        XCTAssertEqual(held.first?.giveUpCount, 3)
        XCTAssertEqual(held.first?.canLetGo, true)
        XCTAssertFalse(RetryPolicy.isRateLimitGiveUp(held.first?.lastError ?? ""))
    }

    func testLettingGoAMealKeepsItAsARefusalAndFreesTheLane() async throws {
        // Content worth keeping is not dropped by Let go: the meal becomes a
        // refusal — off the lane's path, with what the composer had, under
        // a reason that says why — and the create behind it lands on the
        // next flush. The refusal itself is never retried.
        let transport = ScriptedTransport([.status(500, body: "boom")])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)
        for _ in 0..<3 {
            await queue.resume()
            await queue.awaitRetries()
        }
        let before = await store.all
        XCTAssertEqual(before.map(\.canLetGo), [true, false])
        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, Array(repeating: "/api/meals", count: 3), "nothing behind the head moved")

        await transport.script([.ok()])
        let letGo = await queue.letGo(before[0].id, in: .outbox)
        XCTAssertEqual(letGo?.action, .meal)
        let kept = await store.all
        XCTAssertEqual(kept.map(\.payload.action), [.meal, .createDefinition], "kept, not dropped")
        XCTAssertEqual(kept.first?.isRefused, true)
        XCTAssertEqual(kept.first?.isWaiting, false)
        XCTAssertEqual(kept.first?.lastError, WriteQueue.letGoReason(giveUps: 3))
        XCTAssertEqual(kept.first?.payload, .meal(mealCreate()), "with its content")

        await queue.flush(.outbox)
        let after = await store.all.map(\.payload.action)
        XCTAssertEqual(after, [.meal], "the create behind it landed; the refusal waits for the user")
        let paths = await transport.requests.map(\.path)
        XCTAssertEqual(paths.suffix(1), ["/api/exercise-definitions"])
    }

    func testAnOutboxOpThePolicyGaveUpOnIsKeptAsWaitingAndTheNextFlushRetriesIt() async throws {
        // A server that keeps answering 5xx: past the ceiling the op is
        // failed, but marked given-up — still waiting, never dropped — and the
        // next resume (foreground, launch, network back) puts it back and
        // sends it.
        let transport = ScriptedTransport([.status(500, body: "boom"), .status(500, body: "boom"), .status(500, body: "boom"), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 2))
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()

        let kept = await store.all
        XCTAssertEqual(kept.map(\.state), [.failed])
        XCTAssertEqual(kept.first?.gaveUp, true)
        XCTAssertEqual(kept.first?.isWaiting, true)
        XCTAssertEqual(kept.first?.isRefused, false)
        XCTAssertEqual(kept.first?.lastError, "Could not sync after 3 attempts. boom")
        let waiting = await queue.waitingOps(for: .outbox).count
        XCTAssertEqual(waiting, 1)
        let events = await recorder.waitFor { $0.contains { if case .failed(.outbox, .meal, _) = $0 { return true } else { return false } } }
        XCTAssertTrue(events.contains { if case .failed(.outbox, .meal, _) = $0 { return true } else { return false } })
        await recorder.stop()

        await queue.resume()
        await queue.awaitRetries()
        let sent = await transport.requests.count
        XCTAssertEqual(sent, 4)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testRetryPutsBackAGaveUpCompletionButNeverARefusedMeal() async throws {
        // Retry on the day line: the gave-up op goes back with a fresh
        // ladder; the refusal ahead of it is the user's to fix and stays put
        // (a refusal never blocks the lane; a gave-up op does).
        let transport = ScriptedTransport([
            .status(400, body: "Total fat can't be less than saturated + trans"), .status(503, body: "down"), .ok(),
        ])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        let ops = toggle(complete: true)
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        try await queue.enqueue(ops.completion, for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        let before = await store.all
        XCTAssertEqual(before.map(\.gaveUp), [false, true])
        XCTAssertEqual(before.map(\.isRefused), [true, false])

        await queue.retryGaveUp(.outbox)
        let after = await store.all
        XCTAssertEqual(after.map(\.payload.action), [.meal], "the completion landed; the refused meal is untouched")
        XCTAssertEqual(after.first?.isRefused, true)
        XCTAssertEqual(after.first?.lastError, "Total fat can't be less than saturated + trans")
        let sent = await transport.requests.map(\.path)
        XCTAssertEqual(sent, ["/api/meals", "/api/completions", "/api/completions"])
    }

    func testAGaveUpOpKeepsItsPlaceAndWhatWasQueuedBehindItWaits() async throws {
        // Complete, the server keeps failing, the user undoes: the undo must
        // not land before the completion it reverses. The gave-up head
        // blocks the lane; a flush retries it where it stands; once it lands
        // the rest follows in order, and the server ends on the undo.
        let transport = ScriptedTransport([.status(503, body: "down"), .status(503, body: "down"), .ok(), .ok(), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        let complete = toggle(complete: true)
        let undo = toggle(complete: false)
        try await queue.enqueue(complete.completion, for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        let gaveUp = await store.all.map(\.gaveUp)
        XCTAssertEqual(gaveUp, [true])

        try await queue.enqueue(undo.completion, for: .outbox)
        try await queue.enqueue(undo.quick, for: .outbox)
        await queue.flush(.outbox)   // retries the head in place: 503 again, so nothing behind it moves
        await queue.awaitRetries()
        let paths = await transport.requests.map(\.path)
        XCTAssertEqual(paths, ["/api/completions", "/api/completions"], "the undo waits behind the gave-up completion")
        let held = await store.all
        XCTAssertEqual(held.map(\.payload.action), [.completion, .completion, .quickComplete])
        XCTAssertEqual(held.map(\.isWaiting), [true, true, true])
        XCTAssertEqual(held.map(\.gaveUp), [true, false, false])

        await queue.resume()
        await queue.awaitRetries()
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/completions", "/api/completions", "/api/completions", "/api/completions", "/api/workout-sessions"])
        let last = requests[3].body?["completionRow"] as? [String: Any]
        XCTAssertEqual(last?["is_completed"] as? Bool, false, "the server ends on the undo, not the stale completion")
        XCTAssertEqual(requests[4].action, "quick-uncomplete")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testANewerMealEditLandsAfterTheGaveUpOneItSupersedes() async throws {
        let transport = ScriptedTransport([.status(503, body: "down"), .ok(), .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        let v1 = MealOpPayload(kind: .update, id: "ios-fixture-meal-1", title: "v1", day: "2026-09-08", columns: ["title": .string("v1")])
        let v2 = MealOpPayload(kind: .update, id: "ios-fixture-meal-1", title: "v2", day: "2026-09-08", columns: ["title": .string("v2")])
        try await queue.enqueue(.meal(v1), for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        try await queue.enqueue(.meal(v2), for: .outbox)

        await queue.resume()
        await queue.awaitRetries()
        let titles = await transport.requests.map { ($0.body?["fields"] as? [String: Any])?["title"] as? String }
        XCTAssertEqual(titles, ["v1", "v1", "v2"], "v1 lands first, then v2 — never the other way round")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testAGaveUpLibraryCreateIsStillOffered() async throws {
        let transport = ScriptedTransport([.status(503, body: "down")])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        try await queue.enqueue(.createDefinition(pancake), for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        let held = await store.all
        XCTAssertEqual(held.map(\.gaveUp), [true])
        let offered = await queue.pendingDefinitionCreates().map(\.id)
        XCTAssertEqual(offered, ["pancake-fold"], "waiting, so still overlaid on the library")
    }

    // MARK: - A meal in the outbox

    private func mealCreate(id: String = "meal-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90") -> MealOpPayload {
        MealOpPayload(
            kind: .create, id: id, title: "Toast", day: "2026-09-08",
            columns: ["id": .string(id), "title": .string("Toast"), "date": .string("2026-09-08"), "protein_g": .number(12), "carbs_g": .null]
        )
    }

    func testAMealCreateFlushesAsThePostWithTheRowAndAttribution() async throws {
        let transport = ScriptedTransport([.ok(#"{"id":"meal-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90"}"#)])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        await queue.flush(.outbox)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.method), ["POST"])
        XCTAssertEqual(requests.map(\.path), ["/api/meals"])
        XCTAssertEqual(requests[0].body?["id"] as? String, "meal-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90")
        XCTAssertEqual(requests[0].body?["title"] as? String, "Toast")
        XCTAssertEqual(requests[0].body?["protein_g"] as? Int, 12)
        XCTAssertTrue(requests[0].body?["carbs_g"] is NSNull, "a blank column travels as null")
        XCTAssertEqual(requests[0].body?["triggered_by"] as? String, "user")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testAMealEditFlushesAsThePatchWithEveryColumnAndItsLog() async throws {
        let transport = ScriptedTransport([.ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let edit = MealOpPayload(
            kind: .update, id: "ios-fixture-meal-1", title: "Overnight oats", day: "2026-10-02", originalDay: "2026-09-08",
            columns: ["title": .string("Overnight oats"), "date": .string("2026-10-02"), "fiber_g": .null]
        )
        try await queue.enqueue(.meal(edit), for: .outbox)
        await queue.flush(.outbox)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.method), ["PATCH"])
        XCTAssertEqual(requests.map(\.path), ["/api/meals"])
        let fields = requests[0].body?["fields"] as? [String: Any]
        XCTAssertEqual(fields?["title"] as? String, "Overnight oats")
        XCTAssertTrue(fields?["fiber_g"] is NSNull)
        let log = requests[0].body?["log"] as? [String: Any]
        XCTAssertEqual(log?["meal_title"] as? String, "Overnight oats")
        XCTAssertEqual(log?["triggered_by"] as? String, "user")
        XCTAssertEqual(edit.days, ["2026-10-02", "2026-09-08"], "both months re-read once it lands")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testAMealCreateWaitsOutAnOutageAndAReplayAnsweredAsLandedLeavesTheLane() async throws {
        // The first try never hears back; the second is the same row (same id)
        // and the server answers it as already landed. Done, not a failure.
        let transport = ScriptedTransport([.throwNetwork, .ok(#"{"id":"meal-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90","replayed":true}"#)])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, policy: RetryPolicy(maxAttempts: 0))
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        await queue.flush(.outbox)
        await queue.awaitRetries()

        let ids = await transport.requests.map { $0.body?["id"] as? String }
        XCTAssertEqual(ids, Array(repeating: "meal-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90", count: 2), "one id across the replay")
        let left = await store.all.count
        XCTAssertEqual(left, 0)
    }

    func testAMealTheServerRefusesIsKeptAsFailedWithItsReason() async throws {
        let transport = ScriptedTransport([.status(400, body: "Total fat can't be less than saturated + trans")])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(.meal(mealCreate()), for: .outbox)
        await queue.flush(.outbox)

        let failure = QueueEvent.failed(.outbox, .meal, "Total fat can't be less than saturated + trans")
        let events = await recorder.waitFor { $0.contains(failure) }
        XCTAssertTrue(events.contains(failure))
        await recorder.stop()
        let kept = await queue.ops(for: .outbox)
        XCTAssertEqual(kept.map(\.state), [.failed])
        XCTAssertEqual(kept.first?.lastError, "Total fat can't be less than saturated + trans")
    }

    func testToggleAndMealOpsSurviveTheStoresJSONRoundTrip() throws {
        // The GRDB store keeps the payload as JSON: what a relaunch reads back
        // must be what was queued, for every new case.
        let ops = toggle(complete: true)
        let edit = MealOpPayload(kind: .update, id: "ios-fixture-meal-1", title: "Oats", day: "2026-10-02", originalDay: "2026-09-08", columns: ["fiber_g": .null])
        for payload in [ops.completion, ops.quick, .meal(mealCreate()), .meal(edit)] {
            let data = try JSONEncoder().encode(payload)
            XCTAssertEqual(try JSONDecoder().decode(TrackerOpPayload.self, from: data), payload)
        }
        XCTAssertEqual(ops.quick.action.rawValue, "quick-complete")
        XCTAssertEqual(TrackerOpPayload.meal(edit).action.rawValue, "meal")
    }
}

/// A queue store whose writes fail on demand — a full disk, a locked SQLite
/// file. Reads always work, so the queue keeps seeing the op it could not
/// update.
actor FailingWritesStore: WriteQueueStore {
    let inner = MemoryWriteQueueStore()
    var failUpdates = false
    var failDeletes = false
    private(set) var failedWrites = 0

    struct StoreDown: Error {}

    func setFailing(updates: Bool, deletes: Bool) {
        failUpdates = updates
        failDeletes = deletes
    }

    func append(_ op: TrackerOp) async throws -> Int64 { try await inner.append(op) }
    func update(_ op: TrackerOp) async throws -> Bool {
        if failUpdates { failedWrites += 1; throw StoreDown() }
        return try await inner.update(op)
    }
    func delete(id: Int64) async throws {
        if failDeletes { failedWrites += 1; throw StoreDown() }
        try await inner.delete(id: id)
    }
    func tail(for session: SessionKey) async throws -> TrackerOp? { try await inner.tail(for: session) }
    func nextPending(for session: SessionKey) async throws -> TrackerOp? { try await inner.nextPending(for: session) }
    func ops(for session: SessionKey) async throws -> [TrackerOp] { try await inner.ops(for: session) }
    func sessionsWithPending() async throws -> [SessionKey] { try await inner.sessionsWithPending() }
    func purge(session: SessionKey) async throws { try await inner.purge(session: session) }
    func purgeAll() async throws { try await inner.purgeAll() }
}

/// A store write that fails mid-drain stops the drain, emits `storeFailed`, and waits a
/// backoff — it used to be discarded with `try?`, which handed the same op
/// straight back and re-sent it in a loop.
final class WriteQueueStoreFailureTests: XCTestCase {
    private let session = fixtureSession

    private func save() -> TrackerOpPayload {
        .save(SavePayload(setLogs: [setRow(1, weight: "100")], removedSets: []))
    }

    /// Waits until `clock` has been asked for `count` sleeps (five seconds at
    /// most). A retry sleeps in a task of its own, some time after the call
    /// that scheduled it returns, and in no promised order with a retry that
    /// call called off.
    private func waitForSleeps(
        _ count: Int, on clock: HeldClock, file: StaticString = #filePath, line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(5)
        while clock.sleeps.count < count, Date() < deadline {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertEqual(clock.sleeps.count, count, "sleeps asked of the clock", file: file, line: line)
    }

    func testAFailedDeleteAfterASendStopsTheDrainAndBacksOff() async throws {
        let transport = ScriptedTransport([.ok()])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        let recorder = EventRecorder()
        await recorder.start(await queue.subscribe())
        try await queue.enqueue(save(), for: session)
        await store.setFailing(updates: false, deletes: true)

        await queue.flush(session)

        let sent = await transport.requests.count
        XCTAssertEqual(sent, 1, "one send, not a loop re-sending the op its failed delete left behind")
        let expected = QueueEvent.storeFailed(session)
        let events = await recorder.waitFor { $0.contains(expected) }
        XCTAssertTrue(events.contains(expected))

        // The store recovers: the retry re-sends once and clears the row.
        await store.setFailing(updates: false, deletes: false)
        clock.open()
        await queue.awaitRetries()
        let resent = await transport.requests.count
        XCTAssertEqual(resent, 2)
        let left = await store.inner.all.count
        XCTAssertEqual(left, 0)
        XCTAssertEqual(clock.sleeps.count, 1, "exactly one backoff before the re-send")
        await recorder.stop()
    }

    func testAFailedUpdateOnARefusalDoesNotResendInALoop() async throws {
        let transport = ScriptedTransport([.status(400, body: "Invalid setLogs")])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        try await queue.enqueue(save(), for: session)
        await store.setFailing(updates: true, deletes: false)

        await queue.flush(session)

        let sent = await transport.requests.count
        XCTAssertEqual(sent, 1)
        let failedWrites = await store.failedWrites
        XCTAssertEqual(failedWrites, 1)

        // Recovered, the retry re-sends once and records the refusal.
        await store.setFailing(updates: false, deletes: false)
        clock.open()
        await queue.awaitRetries()
        let resent = await transport.requests.count
        XCTAssertEqual(resent, 2)
        XCTAssertEqual(clock.sleeps.count, 1)
        let kept = await store.inner.all
        XCTAssertEqual(kept.map(\.state), [.failed])
    }

    func testAFailedUpdateOnTheTimestampStripStopsTheDrainAndRetriesTheStampedOp() async throws {
        let transport = ScriptedTransport([.status(400, body: "startedAt must be an ISO timestamp within the last 7 days"), .ok()])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        try await queue.enqueue(.start(startedAt: "2026-08-01T00:00:00.000Z"), for: session)
        await store.setFailing(updates: true, deletes: false)

        await queue.flush(session)

        let sent = await transport.requests.count
        XCTAssertEqual(sent, 1, "the stamped op is not re-sent in a loop")

        await store.setFailing(updates: false, deletes: false)
        clock.open()
        await queue.awaitRetries()
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.action), ["start", "start"])
        // The strip was never stored, so the retry sends the stamped original.
        XCTAssertEqual(requests[1].body?["startedAt"] as? String, "2026-08-01T00:00:00.000Z")
        let left = await store.inner.all.count
        XCTAssertEqual(left, 0)
    }

    func testWhileTheStoreStaysDownTheBackoffGrowsAndTheOpGivesUp() async throws {
        // Every send fails on the network; every write fails on the device.
        let transport = ScriptedTransport([.throwNetwork])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let policy = RetryPolicy(baseDelay: 1, maxDelay: 300, maxAttempts: 2)
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock, policy: policy)
        try await queue.enqueue(save(), for: session)
        await store.setFailing(updates: true, deletes: true)

        await queue.flush(session)
        // Each held retry is let through one at a time; the count rides in
        // memory, so the waits grow and the policy's ceiling still arrives.
        for _ in 0..<4 {
            while clock.heldSleeps == 0 { await Task.yield() }
            clock.releaseHeld()
        }
        while clock.heldSleeps == 0 { await Task.yield() }
        XCTAssertEqual(clock.sleeps, [2, 4, 8, 16, 32], "one backoff per store failure, doubling")
        let sent = await transport.requests.count
        XCTAssertEqual(sent, 5)

        // The store recovers: the op is recorded as given up, not retried forever.
        await store.setFailing(updates: false, deletes: false)
        clock.open()
        await queue.awaitRetries()
        let ops = await store.inner.all
        XCTAssertEqual(ops.map(\.state), [.failed])
        XCTAssertEqual(ops.first?.gaveUp, true)
    }

    func testTheCarriedAttemptGoesWithTheOpsNextSuccessfulWrite() async throws {
        // Carried once, stored once: after the store recovers, each failure
        // adds one attempt to the row, not one plus the old carry.
        let transport = ScriptedTransport([.status(500), .status(500), .status(500), .ok()])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        try await queue.enqueue(save(), for: session)
        await store.setFailing(updates: true, deletes: false)
        await queue.flush(session)                         // 500: the attempt is carried, not stored
        await store.setFailing(updates: false, deletes: false)

        while clock.heldSleeps == 0 { await Task.yield() }
        clock.releaseHeld()                                // 500 again: stored with the carry
        while clock.heldSleeps == 0 { await Task.yield() }
        let afterFirst = await store.inner.all.first?.attempts
        clock.releaseHeld()                                // and again: one more, the carry is spent
        while clock.heldSleeps == 0 { await Task.yield() }
        let afterSecond = await store.inner.all.first?.attempts

        XCTAssertEqual(afterFirst, 2)
        XCTAssertEqual(afterSecond, 3)
        clock.open()
        await queue.awaitRetries()
    }

    private let oats = MealOpPayload(kind: .create, id: "meal-oats", title: "Oats", day: "2026-09-08", columns: [:])

    func testRetryAfterALetGoStartsTheLadderFresh() async throws {
        // A carry from a failed store write must not outlive the user's
        // reset: after Let go and Retry the next failure is the first one.
        let transport = ScriptedTransport([.status(500), .status(500), .ok()])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        var meal = try await queue.enqueue(.meal(oats), for: .outbox)
        meal.giveUpCount = TrackerOp.letGoThreshold
        _ = try await store.update(meal)
        await store.setFailing(updates: true, deletes: false)
        await queue.flush(.outbox)                         // 500: the attempt is carried
        await store.setFailing(updates: false, deletes: false)

        let letGo = await queue.letGo(meal.id, in: .outbox)
        XCTAssertEqual(letGo, .meal(oats))
        await queue.retryFailed(.outbox)
        await queue.resume()                               // past the backoff the carry set: 500 again

        let attempts = await store.inner.all.first?.attempts
        XCTAssertEqual(attempts, 1)
        // Two retries sleep: the carry's 2s one, which `resume()` called off,
        // and the 1s one its send scheduled. Each sleeps in its own task, in
        // no promised order, so the newest is not always `sleeps.last`.
        await waitForSleeps(2, on: clock)
        XCTAssertEqual(clock.sleeps.sorted(), [1, 2], "the first rung's backoff, beside the called-off carry's")
        clock.open()
        await queue.awaitRetries()
    }

    func testAFailedUpdateOnABuilderRefusalDoesNotResendInALoop() async throws {
        // 200 with ok:false: the refusal could not be recorded, so the draft
        // still reads pending. The drain must stop, not send it again at once.
        let transport = ScriptedTransport([.ok(#"{"ok":false,"problem":"Bad workout"}"#), .throwNetwork])
        let store = FailingWritesStore()
        let clock = HeldClock()
        let queue = WriteQueue(store: store, client: makeClient(transport), clock: clock)
        let draft = TrackerOpPayload.workoutDraft(WorkoutDraftOpPayload(
            draft: .empty(date: "2026-09-10", title: "Leg day"), today: "2026-09-08", action: .create,
            clientId: "ai-0b9f3c52-6a1e-4c47-9d3a-5f2e8b7c1a90"
        ))
        try await queue.enqueue(draft, for: .outbox)
        await store.setFailing(updates: true, deletes: false)

        await queue.flush(.outbox)

        let sent = await transport.requests.count
        XCTAssertEqual(sent, 1, "one send, then the backoff")
        await store.setFailing(updates: false, deletes: false)
        await transport.script([.ok(#"{"ok":false,"problem":"Bad workout"}"#)])
        clock.open()
        await queue.awaitRetries()
        let kept = await store.inner.all
        XCTAssertEqual(kept.map(\.state), [.failed])
        XCTAssertEqual(kept.first?.lastError, "Bad workout")
    }
}
