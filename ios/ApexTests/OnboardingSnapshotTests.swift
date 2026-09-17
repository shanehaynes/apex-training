import ApexCore
import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate (see ScheduleSnapshotTests).
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/OnboardingSnapshotTests test
final class OnboardingSnapshotTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    @MainActor
    private func model(dismissed: Bool, template: Bool = false, key: Bool = false, goal: Bool = false) -> OnboardingModel {
        ApexFonts.register()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: YouTransport(), tokens: CoachTestTokens())
        let state = ProfileResponse.OnboardingState(
            dismissedAt: dismissed ? "2026-09-07T11:00:00.000Z" : nil, applies: true,
            setup: .init(template: template, key: key, goal: goal)
        )
        return OnboardingModel(deps: OnboardingModel.Dependencies(
            client: client, routes: RouteBus(), corosConfigured: { true }, onTemplateCopied: {}, openKeySheet: {}
        ), state: state)
    }

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    @MainActor
    func testWelcomeFirstStep() {
        snapshot(WelcomeFlowView(model: model(dismissed: false)), named: "welcome-1")
    }

    @MainActor
    func testWelcomeCoachStepWithAction() {
        let model = model(dismissed: false)
        model.stepIndex = 3
        snapshot(WelcomeFlowView(model: model), named: "welcome-coach")
    }

    @MainActor
    func testWelcomeLastStepLargeType() {
        let model = model(dismissed: false)
        model.stepIndex = 7
        snapshot(WelcomeFlowView(model: model).environment(\.sizeCategory, .extraExtraLarge), named: "welcome-last-xxl")
    }

    @MainActor
    func testNudgeCardOneOfThree() {
        snapshot(SetupNudgeCard(model: model(dismissed: true, key: true)).padding(Spacing.screen), named: "nudge", size: CGSize(width: 393, height: 240))
    }

    @MainActor
    func testNudgeCardLargeType() {
        snapshot(SetupNudgeCard(model: model(dismissed: true)).padding(Spacing.screen).environment(\.sizeCategory, .extraExtraLarge), named: "nudge-xxl", size: CGSize(width: 393, height: 360))
    }
}
