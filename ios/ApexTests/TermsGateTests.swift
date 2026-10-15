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
