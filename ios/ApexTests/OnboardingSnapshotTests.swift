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

    /// Page 1 of 4: welcome + the calendar, with the starter-plan button.
    @MainActor
    func testWelcomeFirstPage() {
        snapshot(WelcomeFlowView(model: model(dismissed: false)), named: "welcome-1")
    }

    /// Page 3: the coach step, plus the checklist's goal row under it.
    @MainActor
    func testWelcomeCoachPageWithAction() {
        let model = model(dismissed: false)
        model.pageIndex = 2
        snapshot(WelcomeFlowView(model: model), named: "welcome-coach")
    }

    /// Page 4, the longest: COROS + connectors + the last things, at xxL.
    @MainActor
    func testWelcomeLastPageLargeType() {
        let model = model(dismissed: false)
        model.pageIndex = 3
        snapshot(WelcomeFlowView(model: model).environment(\.sizeCategory, .extraExtraLarge), named: "welcome-last-xxl")
    }

    /// Page 2 at the accessibility sizes, where two headings and two bodies
    /// have the least room.
    @MainActor
    func testWelcomeLogPageAccessibilityType() {
        let model = model(dismissed: false)
        model.pageIndex = 1
        snapshot(WelcomeFlowView(model: model).environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge), named: "welcome-log-axxxl")
    }

    /// Collapsed — one line high, which is all it is until it is asked for.
    @MainActor
    func testNudgeCardOneOfThree() {
        snapshot(SetupNudgeCard(model: model(dismissed: true, key: true)).padding(Spacing.screen), named: "nudge", size: CGSize(width: 393, height: 240))
    }

    /// Open: the three rows, each button going where it says.
    @MainActor
    func testNudgeCardExpanded() {
        snapshot(
            SetupNudgeCard(model: model(dismissed: true, key: true), initiallyExpanded: true).padding(Spacing.screen),
            named: "nudge-expanded", size: CGSize(width: 393, height: 280)
        )
    }

    @MainActor
    func testNudgeCardLargeType() {
        snapshot(SetupNudgeCard(model: model(dismissed: true), initiallyExpanded: true).padding(Spacing.screen).environment(\.sizeCategory, .extraExtraLarge), named: "nudge-xxl", size: CGSize(width: 393, height: 360))
    }

    /// ux-review §3.10: at accessibility sizes the rows wrap instead of
    /// truncating ("Finish settin…", "Add a start…") — the button no longer
    /// claims the width.
    @MainActor
    func testNudgeCardAccessibilityXXXL() {
        snapshot(
            SetupNudgeCard(model: model(dismissed: true, key: true), initiallyExpanded: true).padding(Spacing.screen)
                .environment(\.dynamicTypeSize, .accessibility3),
            named: "nudge-axxxl", size: CGSize(width: 393, height: 700)
        )
    }
}
