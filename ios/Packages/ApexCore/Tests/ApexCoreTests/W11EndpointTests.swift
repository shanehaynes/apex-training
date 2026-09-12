import XCTest
@testable import ApexCore

/// The You tab's write and read surface (W11). Every body is pinned to its
/// exact bytes: the profile allowlist 400s an unknown key, and the two
/// provider-sync actions that write are dispatched on a string discriminator,
/// so a typo here is a runtime failure the compiler cannot see.
final class W11EndpointTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:5314")!
    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }

    // MARK: - Profile writes

    func testProfileWritesSendOnlyTheirOwnAllowlistedKeys() {
        let name = Endpoint.setDisplayName("Alex")
        XCTAssertEqual(name.method, .patch)
        XCTAssertEqual(name.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/profile")
        XCTAssertEqual(body(name), #"{"display_name":"Alex"}"#)

        XCTAssertEqual(body(Endpoint.setAvatarKey("ibex")), #"{"avatar_key":"ibex"}"#)
        XCTAssertEqual(body(Endpoint.dismissOnboarding), #"{"onboarding_dismissed":true}"#)
    }

    /// Whole numbers must not encode as `190.0`: the server takes an integer
    /// and rejects anything else.
    func testHeartRateZonesEncodeAsIntegers() {
        XCTAssertEqual(body(Endpoint.setHeartRateZones(maxHr: 190, thresholdHr: 170)),
                       #"{"max_hr":190,"threshold_hr":170}"#)
    }

    /// Clearing is an explicit null. An omitted key means "leave it alone", so
    /// a nil that vanished would silently do nothing.
    func testClearingSendsExplicitNulls() {
        XCTAssertEqual(body(Endpoint.setHeartRateZones(maxHr: nil, thresholdHr: nil)),
                       #"{"max_hr":null,"threshold_hr":null}"#)
        XCTAssertEqual(body(Endpoint.setCoachModel(nil)), #"{"coach_model":null}"#)
        XCTAssertEqual(body(Endpoint.setAnthropicKey(nil)), #"{"anthropic_api_key":null}"#)
    }

    func testCoachModelAndProfileText() {
        XCTAssertEqual(body(Endpoint.setCoachModel("claude-sonnet-5")), #"{"coach_model":"claude-sonnet-5"}"#)
        // Empty strings are sent, not dropped: clearing the goal is an edit.
        XCTAssertEqual(body(Endpoint.setCoachProfile(goal: "", context: "")),
                       #"{"coach_context":"","coach_goal":""}"#)
        XCTAssertEqual(body(Endpoint.setCoachProfile(goal: "Ski Rainier", context: "Bad left knee")),
                       #"{"coach_context":"Bad left knee","coach_goal":"Ski Rainier"}"#)
    }

    // MARK: - Activity log and the connector

    func testReadsAreBarePlainGets() {
        XCTAssertEqual(Endpoint.mutationsLog.method, .get)
        XCTAssertNil(Endpoint.mutationsLog.body)
        XCTAssertEqual(Endpoint.mutationsLog.url(relativeTo: base)?.absoluteString,
                       "http://127.0.0.1:5314/api/mutations-log")

        XCTAssertEqual(Endpoint.mcpTokens.method, .get)
        XCTAssertNil(Endpoint.mcpTokens.body)
        XCTAssertEqual(Endpoint.mcpTokens.url(relativeTo: base)?.absoluteString,
                       "http://127.0.0.1:5314/api/mcp-tokens")
    }

    func testMintingATokenPostsItsName() {
        let mint = Endpoint.mintMcpToken(name: "Laptop")
        XCTAssertEqual(mint.method, .post)
        XCTAssertEqual(body(mint), #"{"name":"Laptop"}"#)
    }

    /// Revoke keys on `id`, disconnect on `client_id`, and the two must not be
    /// sent together — the server lets `client_id` win, which would revoke far
    /// more than one token.
    func testRevokeAndDisconnectUseDifferentQueryKeys() {
        let revoke = Endpoint.revokeMcpToken(id: "tok-1")
        XCTAssertEqual(revoke.method, .delete)
        XCTAssertEqual(revoke.url(relativeTo: base)?.query, "id=tok-1")
        XCTAssertNil(revoke.body)

        let disconnect = Endpoint.disconnectApp(clientId: "client-9")
        XCTAssertEqual(disconnect.method, .delete)
        XCTAssertEqual(disconnect.url(relativeTo: base)?.query, "client_id=client-9")
        XCTAssertNil(disconnect.body)
    }

    // MARK: - Account

    func testDeleteAccountCarriesTheServersConfirmation() {
        XCTAssertEqual(Endpoint.deleteAccount.method, .delete)
        XCTAssertEqual(Endpoint.deleteAccount.url(relativeTo: base)?.absoluteString,
                       "http://127.0.0.1:5314/api/account")
        XCTAssertEqual(body(Endpoint.deleteAccount), #"{"confirm":"DELETE"}"#)
    }

    // MARK: - COROS

    func testStatusIsTheOneActionWithoutAProvider() {
        XCTAssertEqual(Endpoint.providerStatus.method, .post)
        XCTAssertEqual(Endpoint.providerStatus.url(relativeTo: base)?.absoluteString,
                       "http://127.0.0.1:5314/api/provider-sync")
        XCTAssertEqual(body(Endpoint.providerStatus), #"{"action":"status"}"#)
    }

    /// The whole point of the phase41 column: without `client` the callback
    /// redirects into the web app and the in-app browser never closes.
    func testConnectStartClaimsTheIosClient() {
        XCTAssertEqual(body(Endpoint.providerConnectStart()),
                       #"{"action":"connect-start","client":"ios","provider":"coros"}"#)
        // Omitted entirely for a caller that is not the app — the server reads
        // an absent client as the web.
        XCTAssertEqual(body(Endpoint.providerConnectStart(client: nil)),
                       #"{"action":"connect-start","provider":"coros"}"#)
    }

    func testDisconnectAndAutoSync() {
        XCTAssertEqual(body(Endpoint.providerDisconnect()), #"{"action":"disconnect","provider":"coros"}"#)
        XCTAssertEqual(body(Endpoint.providerAutoSync(enabled: false)),
                       #"{"action":"set-auto-sync","enabled":false,"provider":"coros"}"#)
        XCTAssertEqual(body(Endpoint.providerAutoSync(enabled: true)),
                       #"{"action":"set-auto-sync","enabled":true,"provider":"coros"}"#)
    }

    func testPreviewSendsTheZoneThatPlacesActivitiesOnDates() {
        XCTAssertEqual(body(Endpoint.providerPreview(timezone: "America/Los_Angeles")),
                       #"{"action":"preview","provider":"coros","timezone":"America/Los_Angeles"}"#)
    }

    /// One apply for the whole settled queue. A fill carries its target; a
    /// create carries neither key, because the server rejects a fill missing
    /// them and ignores them otherwise.
    func testApplySendsTheWholeSettledQueue() {
        let apply = Endpoint.providerApply(
            timezone: "America/Los_Angeles",
            decisions: [
                .fill(activityId: "a-1", targetEventId: "e-1", eventDate: "2026-09-09"),
                .create(activityId: "a-2"),
            ]
        )
        XCTAssertEqual(apply.method, .post)
        XCTAssertEqual(body(apply), #"""
        {"action":"apply","decisions":[{"action":"fill","activityId":"a-1","eventDate":"2026-09-09","targetEventId":"e-1"},{"action":"create","activityId":"a-2"}],"provider":"coros","timezone":"America/Los_Angeles"}
        """#)
    }
}
