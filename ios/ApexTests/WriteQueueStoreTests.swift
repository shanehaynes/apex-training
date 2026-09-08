import ApexCore
import XCTest
import ApexPersistence

/// `tracker_ops` over a temp-file pool: round trips, ordering, owner scoping.
final class WriteQueueStoreTests: XCTestCase {
    private func makePool() throws -> DatabasePoolBox {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("apex-queue-\(UUID().uuidString).sqlite")
        return DatabasePoolBox(pool: try ApexDatabase.makePool(at: url))
    }

    private let session = SessionKey(eventId: "ios-fixture-weekly__2026-09-22", eventDate: "2026-09-22")
    private let other = SessionKey(eventId: "ios-fixture-run", eventDate: "2026-09-08")

    private func op(_ payload: TrackerOpPayload, for session: SessionKey) -> TrackerOp {
        TrackerOp(session: session, payload: payload, createdAt: Date(timeIntervalSince1970: 1_000))
    }

    private func save(_ n: Int) -> TrackerOpPayload {
        .save(SavePayload(setLogs: [SetLogRow(
            eventId: session.eventId, eventDate: session.eventDate, section: "exercise",
            exerciseId: "fx-press", exerciseName: "Fixture Press", setNumber: n, actualReps: "5"
        )]))
    }

    func testAppendAssignsIdsAndRoundTripsEveryField() async throws {
        let store = GRDBWriteQueueStore(pool: try makePool().pool, owner: "u1")
        let first = try await store.append(op(.start(startedAt: "2026-09-22T12:00:00.000Z"), for: session))
        let second = try await store.append(op(save(1), for: session))
        XCTAssertLessThan(first, second)

        var stored = try await store.ops(for: session)
        XCTAssertEqual(stored.map(\.id), [first, second])
        XCTAssertEqual(stored[0].payload, .start(startedAt: "2026-09-22T12:00:00.000Z"))
        XCTAssertEqual(stored[0].createdAt.timeIntervalSince1970, 1_000)
        XCTAssertEqual(stored[0].state, .pending)

        stored[1].attempts = 3
        stored[1].lastError = "Invalid score"
        stored[1].state = .failed
        stored[1].payload = save(2)
        try await store.update(stored[1])
        let again = try await store.ops(for: session)
        XCTAssertEqual(again[1].attempts, 3)
        XCTAssertEqual(again[1].lastError, "Invalid score")
        XCTAssertEqual(again[1].state, .failed)
        XCTAssertEqual(again[1].payload, save(2))
    }

    func testTailNextPendingAndSessionsWithPending() async throws {
        let store = GRDBWriteQueueStore(pool: try makePool().pool, owner: "u1")
        let a = try await store.append(op(save(1), for: session))
        _ = try await store.append(op(.cancel, for: other))
        let b = try await store.append(op(save(2), for: session))
        var failed = try await store.ops(for: session)[0]
        failed.state = .failed
        try await store.update(failed)

        let tail = try await store.tail(for: session)
        XCTAssertEqual(tail?.id, b)
        let next = try await store.nextPending(for: session)
        XCTAssertEqual(next?.id, b, "the failed op is skipped")
        // Ordered by each session's oldest *pending* op: the session's first op failed.
        let sessions = try await store.sessionsWithPending()
        XCTAssertEqual(sessions, [other, session])

        try await store.delete(id: b)
        let none = try await store.nextPending(for: session)
        XCTAssertNil(none)
        let v1 = try await store.ops(for: session).map(\.id)
        XCTAssertEqual(v1, [a])
    }

    func testPurgeIsPerSessionAndOwnerScopingHidesOtherUsers() async throws {
        let box = try makePool()
        let mine = GRDBWriteQueueStore(pool: box.pool, owner: "u1")
        let theirs = GRDBWriteQueueStore(pool: box.pool, owner: "u2")
        _ = try await mine.append(op(save(1), for: session))
        _ = try await mine.append(op(save(1), for: other))
        _ = try await theirs.append(op(save(1), for: session))

        let visible = try await theirs.ops(for: session)
        XCTAssertEqual(visible.count, 1, "u2 sees only its own op")
        let pending = try await theirs.sessionsWithPending()
        XCTAssertEqual(pending, [session])

        try await mine.purge(session: session)
        let v2 = try await mine.ops(for: session).count
        XCTAssertEqual(v2, 0)
        let v3 = try await mine.ops(for: other).count
        XCTAssertEqual(v3, 1)
        let v4 = try await theirs.ops(for: session).count
        XCTAssertEqual(v4, 1, "another owner's row survives a purge")

        try await mine.purgeAll()
        let v5 = try await mine.sessionsWithPending()
        XCTAssertEqual(v5, [])
        let v6 = try await theirs.sessionsWithPending()
        XCTAssertEqual(v6, [session])
    }

    /// A real `WriteQueue` over the GRDB store: the relaunch story end to end.
    func testAQueueOverTheStoreFlushesWhatAnEarlierRunLeft() async throws {
        let box = try makePool()
        let store = GRDBWriteQueueStore(pool: box.pool, owner: "u1")
        let down = FailingTransport()
        let first = WriteQueue(store: store, client: ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: down, tokens: Tokens()))
        try await first.enqueue(save(1), for: session)
        await first.flush(session)
        let v7 = try await store.ops(for: session).count
        XCTAssertEqual(v7, 1)

        let up = RecordingTransport()
        let second = WriteQueue(store: store, client: ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: up, tokens: Tokens()))
        await second.flush()
        let v8 = await up.count
        XCTAssertEqual(v8, 1)
        let v9 = try await store.ops(for: session).count
        XCTAssertEqual(v9, 0)
    }

    private struct Tokens: TokenProvider {
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { "t" }
        func signOut() async {}
    }

    private struct FailingTransport: HTTPTransport {
        func send(_ request: URLRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
    }

    private actor RecordingTransport: HTTPTransport {
        private(set) var count = 0
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            count += 1
            return HTTPResponse(status: 200, headers: [:], body: Data(#"{"ok":true}"#.utf8))
        }
    }
}

/// Keeps the pool alive for the test's duration.
final class DatabasePoolBox: @unchecked Sendable {
    let pool: GRDB.DatabasePool
    init(pool: GRDB.DatabasePool) { self.pool = pool }
}

import GRDB
