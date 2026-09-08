import XCTest
@testable import ApexCore

/// The write queue state machine (architecture.md §7), over a scripted transport,
/// an in-memory store and a `TestClock` — backoff runs instantly and is asserted
/// on the recorded sleeps.
final class WriteQueueTests: XCTestCase {
    private let session = fixtureSession
    private let other = SessionKey(eventId: "ios-fixture-run", eventDate: "2026-09-08")

    private func makeQueue(
        _ transport: ScriptedTransport, store: MemoryWriteQueueStore = MemoryWriteQueueStore(),
        clock: TestClock = TestClock(now: Date(timeIntervalSince1970: 1_788_868_800))
    ) -> WriteQueue {
        WriteQueue(store: store, client: makeClient(transport), clock: clock)
    }

    private func save(_ rows: [SetLogRow], removed: [SetKey] = []) -> TrackerOpPayload {
        .save(SavePayload(setLogs: rows, removedSets: removed))
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
        let clock = TestClock()
        let queue = makeQueue(transport, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)

        await queue.flush(session)
        // The failure stopped the chain: finish did not go out behind a lost save.
        let v9 = await transport.requests.map(\.action)
        XCTAssertEqual(v9, ["save"])
        await queue.awaitRetries()
        let v10 = await transport.requests.map(\.action)
        XCTAssertEqual(v10, ["save", "save", "finish"])
        XCTAssertEqual(clock.sleeps, [1])
    }

    func testSessionsAreIndependent() async throws {
        let transport = ScriptedTransport([.throwNetwork, .ok()])
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(save([setRow(1, exerciseId: "fx-row")]), for: other)
        await queue.flush()
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
        let clock = TestClock()
        let store = MemoryWriteQueueStore()
        let queue = makeQueue(transport, store: store, clock: clock)
        try await queue.enqueue(save([setRow(1)]), for: session)
        await queue.flush(session)
        let v14 = await store.all.first?.attempts
        XCTAssertEqual(v14, 1)
        let v15 = await store.all.first?.lastError
        XCTAssertEqual(v15, "No connection.")
        await queue.awaitRetries()
        XCTAssertEqual(clock.sleeps, [1, 2, 4, 8])
        let v16 = await transport.count
        XCTAssertEqual(v16, 5)
        let v17 = await store.all.count
        XCTAssertEqual(v17, 0)
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
        let queue = makeQueue(transport, store: store)
        try await queue.enqueue(save([setRow(1)]), for: session)
        try await queue.enqueue(save([setRow(1, exerciseId: "fx-row")]), for: other)
        await queue.flush(session)  // fails, schedules a retry
        try await queue.enqueue(.finish(FinishPayload(autofillRows: [], finishedAt: nil)), for: session)

        try await queue.cancelSession(session)
        let ops = await store.all
        XCTAssertEqual(ops.map(\.session), [other, session])
        XCTAssertEqual(ops.last?.payload, .cancel)

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
        let queue = makeQueue(transport)
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
    }

    func testARelaunchReplaysWhatTheLastRunLeft() async throws {
        let store = MemoryWriteQueueStore()
        let first = makeQueue(ScriptedTransport([.throwNetwork]), store: store)
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
}
