import ApexCore
import XCTest
@testable import Apex

/// W16 MT: updated Terms or Privacy published while a user is signed in. The
/// app finds out (on sign-in, or from whichever request meets the gate first),
/// puts the re-acceptance screen in place of the tabs, holds the write queue,
/// and lets it all go once the user accepts.
final class TermsGateTests: XCTestCase {
    @MainActor
    private func signedIn(_ env: MockEnvironment) async -> AppModel {
        let model = AppModel(mock: env)
        _ = await model.signIn(email: "agent@apex.local", password: "x")
        model.ensureQueue(owner: "ios-fixture-user", email: "agent@apex.local")
        return model
    }

    /// `waitFor` for a condition only an actor can answer.
    @MainActor
    private func eventually(timeout: Double = 5, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return await condition()
    }

    @MainActor
    func testSignInWithStaleTermsShowsTheScreenWithTheVersions() async throws {
        let model = await signedIn(MockEnvironment(termsStale: true))
        let shown = await waitFor { model.termsUpdate != nil }
        XCTAssertTrue(shown, "the background check finds the gate")
        XCTAssertEqual(model.termsUpdate?.privacyVersion, "privacy-v2")
        XCTAssertEqual(model.termsUpdate?.accepted?.privacyVersion, "privacy-v1", "the screen can say what was accepted before")
    }

    @MainActor
    func testCurrentTermsShowNothing() async throws {
        let model = await signedIn(MockEnvironment(termsStale: false))
        await model.checkTerms()
        XCTAssertNil(model.termsUpdate)
    }

    @MainActor
    func testAnyGatedRequestRaisesTheScreenAndABurstAsksOnce() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = AppModel(mock: env)
        _ = await model.signIn(email: "agent@apex.local", password: "x")
        // No ensureQueue, so no sign-in check: only the 403s can raise it.
        let client = try XCTUnwrap(model.client)
        async let first = try? client.data(for: .schedule(start: "2026-09-01", end: "2026-09-30"))
        async let second = try? client.data(for: .profile)
        async let third = try? client.data(for: .schedule(start: "2026-10-01", end: "2026-10-31"))
        _ = await (first, second, third)
        let shown = await waitFor { model.termsUpdate != nil }
        XCTAssertTrue(shown, "a 403 from any endpoint raises it")
        XCTAssertEqual(model.termsUpdate?.privacyVersion, "privacy-v2", "raised from the read, with the versions")
        try await Task.sleep(for: .milliseconds(300))
        let checks = await env.transport.requests.filter { $0.method == "GET" && $0.path == "/api/terms-acceptance" }.count
        XCTAssertEqual(checks, 1, "every tab's first read meets the gate; the app asks once")
    }

    /// The set-password race: the acceptance POST lands, then a read that set
    /// out before it comes back 403. The server now says current, so nothing
    /// is shown — an invitee is not asked twice.
    @MainActor
    func testALate403AfterTheUserIsCurrentShowsNothing() async throws {
        let model = AppModel(mock: MockEnvironment(termsStale: false))
        _ = await model.signIn(email: "agent@apex.local", password: "x")
        await model.termsGateMet()
        XCTAssertNil(model.termsUpdate)
    }

    /// The whole point: a write made while gated is held, not refused, and
    /// lands once the user accepts.
    @MainActor
    func testAWriteHeldByTheGateLandsAfterAccepting() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = await signedIn(env)
        let queue = try XCTUnwrap(model.trackerServices?.queue)
        let key = SessionKey(eventId: "ios-fixture-weekly__2026-09-08", eventDate: "2026-09-08")
        try await queue.enqueue(.cancel, for: key)
        // `ensureQueue`'s own launch flush can pick the op up first; this
        // flush then only marks a rerun and returns before the 403 is back.
        await queue.flush(key)
        let paused = await eventually { await queue.isPaused }
        XCTAssertTrue(paused, "the gate pauses the queue")
        let held = await queue.status(for: key)
        XCTAssertEqual(held.pendingOps, 1)
        XCTAssertEqual(held.failedOps, 0, "held, not refused")

        _ = await waitFor { model.termsUpdate != nil }
        let error = await model.acceptUpdatedTerms()
        XCTAssertNil(error)
        let landed = await eventually { await queue.status(for: key).pendingOps == 0 }
        XCTAssertTrue(landed, "accepting resumes the queue and the write lands")
    }

    /// Two sessions draining at once: A's 403 pauses the queue while B's write
    /// is still in the air. The user accepts, the resume lands A, and only then
    /// does B's 403 — decided before the acceptance — come back and pause the
    /// queue again. The gate is already cleared, so that pause is the app's to
    /// lift: no scene, network or refresh trigger is coming.
    @MainActor
    func testALate403FromAWriteSentBeforeAcceptingDoesNotStrandTheQueue() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = await signedIn(env)
        let queue = try XCTUnwrap(model.trackerServices?.queue)
        let a = SessionKey(eventId: "ios-fixture-weekly__2026-09-08", eventDate: "2026-09-08")
        let b = SessionKey(eventId: "ios-fixture-weekly__2026-09-15", eventDate: "2026-09-15")
        func settles(_ condition: () async -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                if await condition() { return true }
                try? await Task.sleep(for: .milliseconds(20))
            }
            return await condition()
        }

        await env.transport.hold(bodyContaining: b.eventDate)
        try await queue.enqueue(.cancel, for: a)
        try await queue.enqueue(.cancel, for: b)
        Task { await queue.flush() }
        let pausedByA = await settles { await queue.isPaused }
        let holdingB = await settles { await env.transport.isHolding }
        XCTAssertTrue(pausedByA, "A's 403 pauses the queue")
        XCTAssertTrue(holdingB, "B's write is in the air")

        _ = await waitFor { model.termsUpdate != nil }
        let error = await model.acceptUpdatedTerms()
        XCTAssertNil(error)
        let landedA = await settles { await queue.status(for: a).pendingOps == 0 }
        XCTAssertTrue(landedA, "the resume lands A while B is still out")

        await env.transport.releaseHeld()
        let resumed = await settles {
            let paused = await queue.isPaused
            let pendingB = await queue.status(for: b).pendingOps
            return !paused && pendingB == 0
        }
        XCTAssertTrue(resumed, "B's late 403 does not leave the queue paused with B pending")
        XCTAssertNil(model.termsUpdate, "and puts no screen back")
    }

    /// The sign-in check is still out when a write's 403 pauses the queue, so
    /// that 403's notice finds a check in flight. The user accepts elsewhere
    /// (the web) before the check comes back: it reads current, and that read
    /// has to lift the pause the 403 left.
    @MainActor
    func testAWrite403DuringTheSignInCheckIsLiftedWhenTheCheckReadsCurrent() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = AppModel(mock: env)
        _ = await model.signIn(email: "agent@apex.local", password: "x")
        await env.transport.hold(route: "GET /api/terms-acceptance")
        model.ensureQueue(owner: "ios-fixture-user", email: "agent@apex.local")
        let queue = try XCTUnwrap(model.trackerServices?.queue)
        let client = try XCTUnwrap(model.client)
        let key = SessionKey(eventId: "ios-fixture-weekly__2026-09-08", eventDate: "2026-09-08")
        func settles(_ condition: () async -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                if await condition() { return true }
                try? await Task.sleep(for: .milliseconds(20))
            }
            return await condition()
        }

        let checking = await settles { await env.transport.isHolding }
        XCTAssertTrue(checking, "the sign-in check is in the air")
        try await queue.enqueue(.cancel, for: key)
        await queue.flush(key)
        let paused = await settles { await queue.isPaused }
        XCTAssertTrue(paused, "the write's 403 pauses the queue")

        _ = try await client.send(.termsAcceptance, as: TermsStatus.self)
        await env.transport.releaseHeld()
        let landed = await settles {
            let isPaused = await queue.isPaused
            let pending = await queue.status(for: key).pendingOps
            return !isPaused && pending == 0
        }
        XCTAssertTrue(landed, "the check's current read lifts the 403's pause")
        XCTAssertNil(model.termsUpdate)
    }

    @MainActor
    func testAcceptingClearsTheScreenAndTheGate() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = await signedIn(env)
        _ = await waitFor { model.termsUpdate != nil }
        let error = await model.acceptUpdatedTerms()
        XCTAssertNil(error)
        XCTAssertNil(model.termsUpdate)
        let client = try XCTUnwrap(model.client)
        let schedule = try? await client.data(for: .schedule(start: "2026-09-01", end: "2026-09-30"))
        XCTAssertNotNil(schedule, "gated reads answer again")
    }

    @MainActor
    func testSignOutDropsTheScreen() async throws {
        let model = await signedIn(MockEnvironment(termsStale: true))
        _ = await waitFor { model.termsUpdate != nil }
        await model.tearDown(purgeCache: true)
        XCTAssertNil(model.termsUpdate, "the next account starts unknown")
    }
}
