import ApexCore
import ApexFeatures
import XCTest

/// W13: the first-run model over a scripted profile. The verdicts come from the
/// server's `onboarding` block; these prove the model reads them, latches the
/// dismissal, sends the two writes, and routes each button where it says.
final class OnboardingModelTests: XCTestCase {
    private static func profile(dismissed: Bool, applies: Bool = true, template: Bool = false, key: Bool = false, goal: Bool = false) -> Data {
        var object = try! JSONSerialization.jsonObject(with: YouTransport.fixture("profile.json")) as! [String: Any]
        object["onboarding"] = [
            "dismissedAt": dismissed ? "2026-09-07T11:00:00.000Z" : NSNull(),
            "applies": applies,
            "setup": ["template": template, "key": key, "goal": goal],
        ] as [String: Any]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    @MainActor
    private func make(_ transport: YouTransport, coros: Bool = true) -> (OnboardingModel, RouteBus, Recorder) {
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
        let routes = RouteBus()
        let recorder = Recorder()
        let model = OnboardingModel(deps: OnboardingModel.Dependencies(
            client: client, routes: routes, corosConfigured: { coros },
            onTemplateCopied: { recorder.templateCopied += 1 },
            openKeySheet: { recorder.keySheetOpened += 1 }
        ))
        return (model, routes, recorder)
    }

    @MainActor
    private final class Recorder {
        var templateCopied = 0
        var keySheetOpened = 0
    }

    @MainActor
    func testFreshAccountShowsTheWelcomeFlowAndNoCard() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: false)))
        let (model, _, _) = make(transport)
        await model.start()
        XCTAssertTrue(model.showsWelcome)
        XCTAssertFalse(model.showsNudge, "the card waits for the flow to be dismissed")
        XCTAssertEqual(model.welcomeSteps.map(\.id), ["welcome", "calendar", "tracker", "coach", "structure", "coros", "connectors", "more"])
    }

    @MainActor
    func testDismissedAccountShowsTheCardWithTheServersVerdicts() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: true, key: true)))
        let (model, _, _) = make(transport)
        await model.start()
        XCTAssertFalse(model.showsWelcome)
        XCTAssertTrue(model.showsNudge)
        XCTAssertEqual(model.nudgeRows.map(\.id), [.template, .key, .goal])
        XCTAssertEqual(model.nudgeRows.map(\.done), [false, true, false])
        XCTAssertEqual(model.nudgeDoneCount, 1)
        model.nudgeHidden = true
        XCTAssertFalse(model.showsNudge, "the close is session-only, no write")
        XCTAssertTrue(transport.requests("/api/profile").filter { $0.method == "PATCH" }.isEmpty)
    }

    @MainActor
    func testEverythingDoneOrTemplateSourceShowsNothing() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: true, template: true, key: true, goal: true)))
        let (done, _, _) = make(transport)
        await done.start()
        XCTAssertFalse(done.showsNudge)

        let source = YouTransport()
        source.set("GET /api/profile", .json(200, Self.profile(dismissed: false, applies: false)))
        let (shane, _, _) = make(source)
        await shane.start()
        XCTAssertFalse(shane.showsWelcome, "the template source is set up by definition")
        XCTAssertFalse(shane.showsNudge)
    }

    @MainActor
    func testTheCorosStepDropsWhenNoProviderIsConfigured() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: false)))
        let (model, _, _) = make(transport, coros: false)
        await model.start()
        XCTAssertFalse(model.welcomeSteps.contains { $0.id == "coros" })
        XCTAssertEqual(model.welcomeSteps.count, 7)
    }

    @MainActor
    func testDismissLatchesAtOnceAndPatchesTheServer() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: false)))
        transport.set("PATCH /api/profile", .json(200, Data(#"{"ok":true}"#.utf8)))
        let (model, _, _) = make(transport)
        await model.start()
        await model.dismissWelcome()
        XCTAssertFalse(model.showsWelcome)
        XCTAssertTrue(model.showsNudge, "the card takes over even before the re-read lands")
        let patch = transport.requests("/api/profile").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.body?["onboarding_dismissed"] as? Bool, true)
    }

    @MainActor
    func testCopyTemplatePostsRefreshesAndTicksTheRow() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: true)))
        transport.set("POST /api/template-copy", .json(200, Data(#"{"events":3,"definitions":1}"#.utf8)))
        let (model, _, recorder) = make(transport)
        await model.start()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: true, template: true)))
        await model.copyTemplate()
        XCTAssertEqual(transport.requests("/api/template-copy").count, 1)
        XCTAssertEqual(recorder.templateCopied, 1, "the schedule re-reads its window")
        XCTAssertEqual(model.nudgeRows.first?.done, true)
    }

    @MainActor
    func testTheKeyButtonLeavesTheFlowForTheYouTabsKeySheet() async {
        let transport = YouTransport()
        transport.set("GET /api/profile", .json(200, Self.profile(dismissed: false)))
        transport.set("PATCH /api/profile", .json(200, Data(#"{"ok":true}"#.utf8)))
        let (model, routes, recorder) = make(transport)
        await model.start()
        let coach = model.welcomeSteps.first { $0.id == "coach" }!
        await model.run(coach.action!, for: coach.id)
        XCTAssertFalse(model.showsWelcome, "leaving for a settings screen spends the one-shot flow")
        XCTAssertEqual(routes.tab, .you)
        XCTAssertEqual(recorder.keySheetOpened, 1)

        await model.run(OnboardingCatalog.checklistItem(.goal)!.action, for: "goal")
        XCTAssertEqual(routes.pendingYou, .coachProfile)
        await model.run(OnboardingCatalog.checklistItem(.connector)!.action, for: "connector")
        XCTAssertEqual(routes.pendingYou, .connector)
        await model.run(OnboardingCatalog.checklistItem(.coros)!.action, for: "coros")
        XCTAssertEqual(routes.pendingYou, .coros)
    }
}
