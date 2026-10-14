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
    func testAnyGatedRequestRaisesTheScreen() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = AppModel(mock: env)
        _ = await model.signIn(email: "agent@apex.local", password: "x")
        // No ensureQueue, so no sign-in check: only the 403 can raise it.
        let client = try XCTUnwrap(model.client)
        _ = try? await client.data(for: .schedule(start: "2026-09-01", end: "2026-09-30"))
        _ = try? await client.data(for: .schedule(start: "2026-09-01", end: "2026-09-30"))
        let shown = await waitFor { model.termsUpdate != nil }
        XCTAssertTrue(shown, "a 403 from any endpoint raises it")
        XCTAssertFalse(model.termsUpdate?.current ?? true)
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
