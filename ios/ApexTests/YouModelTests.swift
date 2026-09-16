import ApexCore
import ApexFeatures
import XCTest

final class YouModelTests: XCTestCase {
    // MARK: - Profile edits

    @MainActor
    func testStartReadsTheProfileAndCorosStatus() async {
        let transport = YouTransport.healthy()
        let model = makeYouModel(transport)
        await model.start()
        XCTAssertEqual(model.displayName, "Shane")
        XCTAssertEqual(model.heartRateLabel, "165 · 188 bpm")
        XCTAssertEqual(model.keyStatusLabel, "Not set")
        XCTAssertEqual(model.selectedModel?.label, "Opus 5", "no pick → the server's resolved default")
        XCTAssertTrue(model.coros.isConfigured)
        XCTAssertEqual(model.coros.statusLabel, "Connected")
    }

    @MainActor
    func testDisplayNameSendsOnlyItsKeyAndSkipsNoOps() async {
        let transport = YouTransport.healthy()
        let model = makeYouModel(transport)
        await model.start()
        let r1 = await model.saveDisplayName("  Shane ")
        XCTAssertNil(r1, "unchanged after trimming")
        let r2 = await model.saveDisplayName("")
        XCTAssertNil(r2, "blank is ignored, not sent")
        XCTAssertTrue(transport.requests("/api/profile").filter { $0.method == "PATCH" }.isEmpty)
        let r3 = await model.saveDisplayName("Shane H")
        XCTAssertNil(r3)
        let patch = transport.requests("/api/profile").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.body?.keys.sorted(), ["display_name"])
        XCTAssertEqual(patch?.body?["display_name"] as? String, "Shane H")
    }

    @MainActor
    func testZoneParsingHonoursTheHandlerBounds() {
        XCTAssertEqual(YouModel.parseZone("", bounds: 100...250), YouModel.Zone(value: nil), "blank clears")
        XCTAssertEqual(YouModel.parseZone(" 188 ", bounds: 100...250), YouModel.Zone(value: 188))
        XCTAssertNil(YouModel.parseZone("99", bounds: 100...250))
        XCTAssertNil(YouModel.parseZone("251", bounds: 100...250))
        XCTAssertNil(YouModel.parseZone("18.5", bounds: 100...250))
    }

    @MainActor
    func testHeartRateSavesBothZonesInOneWriteWithNullForClear() async {
        let transport = YouTransport.healthy()
        let model = makeYouModel(transport)
        await model.start()
        let r4 = await model.saveHeartRate(maxHr: "300", thresholdHr: "165")
        XCTAssertEqual(r4, "Max HR must be a whole number between 100 and 250")
        let r5 = await model.saveHeartRate(maxHr: "190", thresholdHr: "")
        XCTAssertNil(r5)
        let patch = transport.requests("/api/profile").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.body?["max_hr"] as? Int, 190)
        XCTAssertTrue(patch?.body?["threshold_hr"] is NSNull, "clearing is an explicit null, not an omission")
    }

    @MainActor
    func testCoachProfileClearingIsASave() async {
        let transport = YouTransport.healthy()
        let model = makeYouModel(transport)
        await model.start()
        let r6 = await model.saveCoachProfile(goal: "", context: "")
        XCTAssertNil(r6)
        let patch = transport.requests("/api/profile").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.body?["coach_goal"] as? String, "")
        XCTAssertEqual(patch?.body?["coach_context"] as? String, "")
    }

    @MainActor
    func testChangePasswordAppliesTheWebRules() async {
        let model = makeYouModel(YouTransport.healthy())
        let r7 = await model.changePassword("short", confirm: "short")
        XCTAssertEqual(r7, "Password must be at least 8 characters.")
        let r8 = await model.changePassword("longenough", confirm: "different")
        XCTAssertEqual(r8, "Passwords do not match.")
        let r9 = await model.changePassword("longenough", confirm: "longenough")
        XCTAssertNil(r9)
    }

    @MainActor
    func testDeleteAccountSendsTheServersConfirmAndSignsOut() async {
        let transport = YouTransport.healthy()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
        let deleted = Latch()
        let model = YouModel(services: YouServices(
            client: client, publicOrigin: URL(string: "https://x.test")!, email: "a@b.c",
            onAccountDeleted: { deleted.fire() }
        ))
        let r10 = await model.deleteAccount()
        XCTAssertNil(r10)
        XCTAssertEqual(transport.requests("/api/account").first?.body?["confirm"] as? String, "DELETE")
        XCTAssertTrue(deleted.fired)

        transport.set("DELETE /api/account", status: 500, body: "boom")
        let r11 = await model.deleteAccount()
        XCTAssertEqual(r11, "Deletion failed. Nothing was removed — try again, or get in touch.")
    }

    // MARK: - COROS

    @MainActor
    func testSyncQueuesOnlyMatchesAndAppliesEveryDecisionOnce() async {
        let transport = YouTransport.healthy()
        let scheduleRefreshed = Latch()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
        let coros = CorosModel(services: YouServices(
            client: client, publicOrigin: URL(string: "https://x.test")!, email: nil, timeZone: TimeZone(identifier: "America/New_York")!,
            clock: TestClock(now: coachTestNow), onScheduleChanged: { scheduleRefreshed.fire() }
        ))
        await coros.refreshStatus()
        await coros.sync()
        // The ride has no match: it imports without asking. The run waits.
        XCTAssertEqual(coros.queue.map(\.activity.activityId), ["ios-fixture-run-1"])
        XCTAssertTrue(coros.isSyncing)
        XCTAssertTrue(transport.requests("/api/provider-sync", action: "apply").isEmpty, "nothing is written until the queue settles")
        XCTAssertEqual(transport.requests("/api/provider-sync", action: "preview").first?.body?["timezone"] as? String, "America/New_York")

        await coros.settle(fill: true)
        XCTAssertTrue(coros.queue.isEmpty)
        XCTAssertFalse(coros.isSyncing)
        let apply = transport.requests("/api/provider-sync", action: "apply")
        XCTAssertEqual(apply.count, 1)
        let decisions = apply.first?.body?["decisions"] as? [[String: Any]] ?? []
        XCTAssertEqual(decisions.count, 2)
        XCTAssertEqual(decisions.first?["action"] as? String, "create")
        XCTAssertEqual(decisions.first?["activityId"] as? String, "ios-fixture-ride-1")
        XCTAssertEqual(decisions.last?["action"] as? String, "fill")
        XCTAssertEqual(decisions.last?["targetEventId"] as? String, "ios-fixture-planned-run")
        XCTAssertEqual(decisions.last?["eventDate"] as? String, "2026-09-09")
        XCTAssertTrue(scheduleRefreshed.fired)
        XCTAssertEqual(coros.pendingFillCount, 0)
    }

    @MainActor
    func testKeepSeparateCreatesAndASecondSettleIsIgnored() async {
        let transport = YouTransport.healthy()
        let coros = makeYouModel(transport).coros
        await coros.refreshStatus()
        await coros.sync()
        await coros.settle(fill: false)
        await coros.settle(fill: false)
        let apply = transport.requests("/api/provider-sync", action: "apply")
        XCTAssertEqual(apply.count, 1)
        let decisions = apply.first?.body?["decisions"] as? [[String: Any]] ?? []
        XCTAssertEqual(decisions.map { $0["action"] as? String }, ["create", "create"])
    }

    @MainActor
    func testAbandoningTheQueueWritesNothing() async {
        let transport = YouTransport.healthy()
        let coros = makeYouModel(transport).coros
        await coros.refreshStatus()
        await coros.sync()
        coros.abandonQueue()
        XCTAssertTrue(coros.queue.isEmpty)
        XCTAssertFalse(coros.isSyncing)
        XCTAssertTrue(transport.requests("/api/provider-sync", action: "apply").isEmpty)
    }

    @MainActor
    func testAPreview409MarksTheConnectionExpired() async {
        let transport = YouTransport.healthy()
        transport.set("POST /api/provider-sync preview", status: 409, body: "provider-expired")
        let coros = makeYouModel(transport).coros
        await coros.refreshStatus()
        await coros.sync()
        XCTAssertEqual(coros.status, .expired)
        XCTAssertFalse(coros.isSyncing)
    }

    @MainActor
    func testConnectSkipsTheBrowserWhenTheServerAnswersWithTheCallback() async {
        let transport = YouTransport.healthy(corosStatus: "disconnected")
        let coros = makeYouModel(transport).coros
        await coros.refreshStatus()
        XCTAssertEqual(coros.status, .disconnected)
        transport.set("POST /api/provider-sync status", .json(200, YouTransport.fixture("provider-status.json")))
        var opened = false
        await coros.connect { url in opened = true; return url }
        XCTAssertFalse(opened, "an app-scheme authorize URL is the callback itself")
        XCTAssertEqual(coros.status, .connected)
        XCTAssertEqual(transport.requests("/api/provider-sync", action: "connect-start").first?.body?["client"] as? String, "ios")
    }

    @MainActor
    func testConnectPassesARealAuthorizeURLToTheBrowserAndReadsItsCallback() async {
        let transport = YouTransport.healthy(corosStatus: "disconnected")
        transport.set("POST /api/provider-sync connect-start", .json(200, Data(#"{"authorizeUrl":"https://open.coros.com/oauth2/authorize?x=1"}"#.utf8)))
        let coros = makeYouModel(transport).coros
        var seen: URL?
        await coros.connect { url in
            seen = url
            return URL(string: "apextraining://connect_error?provider=coros&reason=denied")!
        }
        XCTAssertEqual(seen?.host, "open.coros.com")
        XCTAssertEqual(CorosModel.failureMessage(reason: "denied"), "COROS connection declined — nothing was linked.")
        XCTAssertEqual(CorosModel.failureMessage(reason: "expired"), "The COROS sign-in expired — try again.")
        XCTAssertEqual(CorosModel.failureMessage(reason: "exchange_failed"), "COROS connection failed — try again.")
    }

    @MainActor
    func testAutoSyncIsOptimisticAndReverts() async {
        let transport = YouTransport.healthy()
        let coros = makeYouModel(transport).coros
        await coros.refreshStatus()
        XCTAssertTrue(coros.autoSync)
        await coros.setAutoSync(false)
        XCTAssertFalse(coros.autoSync)
        XCTAssertEqual(transport.requests("/api/provider-sync", action: "set-auto-sync").first?.body?["enabled"] as? Bool, false)

        transport.set("POST /api/provider-sync set-auto-sync", status: 500, body: "boom")
        await coros.setAutoSync(true)
        XCTAssertFalse(coros.autoSync, "the failed flip reverts")
    }

    @MainActor
    func testApplySummaryReadsLikeTheWebToast() {
        XCTAssertEqual(CorosModel.summary(SyncApplyOutcome(created: 1, filled: 1, errors: [])), "COROS: Imported 1 activity · filled 1 planned workout")
        XCTAssertEqual(CorosModel.summary(SyncApplyOutcome(created: 0, filled: 0, errors: [])), "COROS: Nothing new")
        XCTAssertEqual(
            CorosModel.summary(SyncApplyOutcome(created: 2, filled: 0, errors: [.init(activityId: "a", error: "write-failed")])),
            "COROS: Imported 2 activities · 1 failed"
        )
    }

    @MainActor
    func testFillPromptNamesTheActivityAndThePlannedWorkout() throws {
        let preview = try JSONDecoder().decode(SyncPreviewResponse.self, from: YouTransport.fixture("provider-preview.json"))
        XCTAssertEqual(CorosModel.fillPrompt(preview.proposals[0]), "Trail Run · 7:05 AM · 5.20 mi — fill planned “Planned Morning Run”?")
    }

    // MARK: - AI connector

    @MainActor
    func testMintRevealsOnceThenReloadsTheList() async {
        let transport = YouTransport.healthy()
        let connector = makeYouModel(transport).connector
        await connector.load()
        XCTAssertEqual(connector.statusLabel, "1 token")
        XCTAssertFalse(connector.canMint)
        connector.name = "  Claude Code "
        XCTAssertTrue(connector.canMint)
        await connector.mint()
        XCTAssertEqual(connector.minted?.token, "apx_test_token")
        XCTAssertEqual(connector.name, "")
        XCTAssertEqual(transport.requests("/api/mcp-tokens").filter { $0.method == "POST" }.first?.body?["name"] as? String, "Claude Code")
        XCTAssertEqual(transport.requests("/api/mcp-tokens").filter { $0.method == "GET" }.count, 2)
    }

    @MainActor
    func testRevokeKeepsTheRowMarkedAndDisconnectDropsTheApp() async {
        let transport = YouTransport.healthy()
        let connector = makeYouModel(transport).connector
        await connector.load()
        let token = try! XCTUnwrap(connector.activeTokens.first)
        await connector.revoke(token)
        XCTAssertTrue(connector.activeTokens.isEmpty)
        XCTAssertEqual(connector.tokens.count, 1, "revoked rows stay, as the web keeps them")
        XCTAssertEqual(transport.requests("/api/mcp-tokens").last?.query, "id=\(token.id)")

        let app = try! XCTUnwrap(connector.connections.first)
        await connector.disconnect(app)
        XCTAssertTrue(connector.connections.isEmpty)
        XCTAssertEqual(transport.requests("/api/mcp-tokens").last?.query, "client_id=ios-fixture-client-1")
    }

    // MARK: - Activity log

    @MainActor
    func testActivityLogLoadsAndLabels() async {
        let model = makeYouModel(YouTransport.healthy()).activity
        await model.load()
        XCTAssertEqual(model.entries?.count, 5)
        XCTAssertEqual(ActivityLogModel.operationLabel("update_instance"), "Rescheduled occurrence of")
        XCTAssertEqual(ActivityLogModel.operationLabel("frobnicate"), "frobnicate")
        let archived = try! XCTUnwrap(model.entries?[2])
        XCTAssertEqual(ActivityLogModel.suffix(archived), " (library)")
        XCTAssertEqual(model.time(archived), "Sep 8, 11:00")
    }

    @MainActor
    func testActivityLogFailureIsQuiet() async {
        let transport = YouTransport.healthy()
        transport.set("GET /api/mutations-log", .fail)
        let model = makeYouModel(transport).activity
        await model.load()
        XCTAssertTrue(model.failed)
        XCTAssertNil(model.entries)
    }
}

@MainActor
final class Latch {
    private(set) var fired = false
    func fire() { fired = true }
}
