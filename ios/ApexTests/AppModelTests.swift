import ApexCore
import XCTest
@testable import Apex

/// Owner-change teardown (#199). A second account on the same device must not
/// see the first account's cached workouts, profile or prefetched bootstraps,
/// and the presenters must be rebuilt rather than reused — `ScheduleModel.start()`
/// latches on a flag `stop()` never clears, so a surviving instance would never
/// load again for the new owner.
final class AppModelTests: XCTestCase {
    /// A cache kind nothing writes on its own: only the tracker fills it, so a
    /// row here survives exactly as long as the teardown lets it.
    private static let staleKey = "e-owner-a/2026-09-08"

    @MainActor
    private func makeModel(_ env: MockEnvironment) async throws -> AppModel {
        let model = AppModel(mock: env)
        model.ensureQueue(owner: "owner-a", email: "a@apex.local")
        XCTAssertNotNil(model.trackerServices, "the first owner builds without a teardown")
        try await env.cache.write(CacheEntry(
            kind: .trackerBootstrap, key: Self.staleKey,
            json: Data(#"{"owner":"a"}"#.utf8), fetchedAt: Date()
        ))
        return model
    }

    @MainActor
    func testASecondAccountPurgesTheFirstAccountsCacheAndRebuildsThePresenters() async throws {
        let env = MockEnvironment()
        let model = try await makeModel(env)
        let firstSchedule = model.schedule
        let firstAnalytics = model.analytics

        model.ensureQueue(owner: "owner-b", email: "b@apex.local")
        let switched = await waitFor { model.schedule !== firstSchedule && model.trackerServices != nil }
        XCTAssertTrue(switched, "an owner change must tear down and rebuild")

        let leftover = try await env.cache.read(kind: .trackerBootstrap, key: Self.staleKey)
        XCTAssertNil(leftover, "the previous owner's cached rows must not outlive the switch")
        XCTAssertFalse(model.analytics === firstAnalytics, "analytics is rebuilt with the schedule")
        XCTAssertNotNil(model.coach, "the new owner gets their own coach over their own conversations")
    }

    /// The expiry path (`AuthService.expire` via the token provider's hook):
    /// same owner, so the cache is theirs and stays — but the presenters go,
    /// because a stopped one never restarts.
    @MainActor
    func testExpiryRebuildsThePresentersWithoutPurgingTheCache() async throws {
        let env = MockEnvironment()
        let model = try await makeModel(env)
        let firstSchedule = model.schedule

        await model.tearDown(purgeCache: false)

        let kept = try await env.cache.read(kind: .trackerBootstrap, key: Self.staleKey)
        XCTAssertNotNil(kept, "an expired session is the same owner: their cache still renders")
        XCTAssertFalse(model.schedule === firstSchedule, "the stopped presenter is replaced, not reused")
        XCTAssertNil(model.trackerServices)
        XCTAssertNil(model.coach)
        XCTAssertNil(model.you)
        XCTAssertNil(model.onboarding)
    }

    /// Sign-out purges, and the purge finishes *before* the replacement
    /// presenters exist — the old code built them over the cache first and
    /// left the purge running behind them in a detached task.
    @MainActor
    func testSignOutFinishesThePurgeBeforeItRebuildsThePresenters() async throws {
        let env = MockEnvironment()
        let model = try await makeModel(env)
        let firstSchedule = model.schedule

        model.signOut()
        let rebuilt = await waitFor { model.schedule !== firstSchedule }
        XCTAssertTrue(rebuilt, "sign-out must finish its teardown")

        let leftover = try await env.cache.read(kind: .trackerBootstrap, key: Self.staleKey)
        XCTAssertNil(leftover, "the purge is awaited before the new presenters can read")
        XCTAssertNil(model.trackerServices)
    }
}
