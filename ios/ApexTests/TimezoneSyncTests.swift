import ApexCore
import XCTest
@testable import Apex

/// phase58: the app writes the device's IANA zone to `profiles.timezone`, so
/// the server's paths with no client to ask compute "today" where the athlete
/// is. Once after sign-in, again when the zone changes, never while the terms
/// gate is up.
final class TimezoneSyncTests: XCTestCase {
    @MainActor
    private func signedIn(_ env: MockEnvironment, zone: String) async -> AppModel {
        let model = AppModel(mock: env)
        model.deviceTimeZone = { zone }
        _ = await model.signIn(email: "agent@apex.local", password: "x")
        model.ensureQueue(owner: "ios-fixture-user", email: "agent@apex.local")
        return model
    }

    /// Every zone the app has PATCHed, in order.
    private static func sentZones(_ env: MockEnvironment) async -> [String] {
        await env.transport.requests.compactMap { request in
            guard request.method == "PATCH", request.path == "/api/profile", let body = request.body,
                  let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
            return object["timezone"] as? String
        }
    }

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
    func testSignInWritesTheDeviceZoneOnceAndAMatchingZoneSendsNothing() async throws {
        let env = MockEnvironment(termsStale: false)
        let model = await signedIn(env, zone: "America/Chicago")
        let sent = await eventually { await Self.sentZones(env) == ["America/Chicago"] }
        XCTAssertTrue(sent, "the fixture profile has no zone; sign-in writes the device's")
        _ = await waitFor { !model.isSyncingTimezone }

        // A foreground with the zone unchanged: the stored one now matches.
        await model.syncTimezone()
        let zones = await Self.sentZones(env)
        XCTAssertEqual(zones, ["America/Chicago"])
    }

    @MainActor
    func testATripWritesTheNewZoneOnTheNextSync() async throws {
        let env = MockEnvironment(termsStale: false)
        let model = await signedIn(env, zone: "America/Chicago")
        _ = await eventually { await Self.sentZones(env).count == 1 }
        // The sign-in sync is still waiting on its PATCH; a sync meanwhile is
        // one the in-flight guard drops, by design. Let it land first.
        _ = await waitFor { !model.isSyncingTimezone }

        model.deviceTimeZone = { "Asia/Tokyo" }
        await model.syncTimezone()
        let zones = await Self.sentZones(env)
        XCTAssertEqual(zones, ["America/Chicago", "Asia/Tokyo"])
    }

    /// The trip case through the real hook: a foreground notices the new zone.
    @MainActor
    func testAForegroundAfterATripWritesTheNewZone() async throws {
        let env = MockEnvironment(termsStale: false)
        let model = await signedIn(env, zone: "America/Chicago")
        _ = await eventually { await Self.sentZones(env).count == 1 }
        _ = await waitFor { !model.isSyncingTimezone }

        model.deviceTimeZone = { "Asia/Tokyo" }
        model.scenePhase(.active)
        let sent = await eventually { await Self.sentZones(env) == ["America/Chicago", "Asia/Tokyo"] }
        XCTAssertTrue(sent)
    }

    /// Once confirmed, an unchanged zone costs a foreground nothing: no profile
    /// read, and no write even if the web has since stored another spelling.
    @MainActor
    func testAConfirmedZoneSkipsTheProfileRead() async throws {
        let env = MockEnvironment(termsStale: false)
        let model = await signedIn(env, zone: "America/Chicago")
        _ = await eventually { await Self.sentZones(env).count == 1 }
        _ = await waitFor { !model.isSyncingTimezone }

        // Other models read the profile on their own clocks after sign-in
        // (onboarding); let them land before taking the baseline.
        try await Task.sleep(for: .milliseconds(800))
        let reads = { await env.transport.requests.filter { $0.method == "GET" && $0.path == "/api/profile" }.count }
        let before = await reads()
        await model.syncTimezone()
        await model.syncTimezone()
        let after = await reads()
        XCTAssertEqual(after, before)
        let zones = await Self.sentZones(env)
        XCTAssertEqual(zones, ["America/Chicago"])
    }

    @MainActor
    func testNothingIsSentBehindTheTermsGateAndTheZoneFollowsTheAcceptance() async throws {
        let env = MockEnvironment(termsStale: true)
        let model = await signedIn(env, zone: "America/Chicago")
        _ = await waitFor { model.termsUpdate != nil }
        await model.syncTimezone()
        try await Task.sleep(for: .milliseconds(300))
        let held = await Self.sentZones(env)
        XCTAssertEqual(held, [], "every gated route 403s until the terms are accepted")

        let error = await model.acceptUpdatedTerms()
        XCTAssertNil(error)
        let sent = await eventually { await Self.sentZones(env) == ["America/Chicago"] }
        XCTAssertTrue(sent, "accepting writes the zone")
    }
}
