import ApexCore
import ApexFeatures
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/YouSnapshotTests test
final class YouSnapshotTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize = CGSize(width: 393, height: 852)) {
        ApexFonts.register()
        let framed = view.frame(width: size.width, height: size.height).background(ApexColor.bgPrimary).preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    @MainActor
    private func loaded(hasKey: Bool = false) async -> YouModel {
        let model = makeYouModel(YouTransport.healthy(hasKey: hasKey))
        await model.start()
        await model.connector.load()
        return model
    }

    /// The root, with every section's status filled in.
    @MainActor
    func testRoot() async {
        let model = await loaded(hasKey: true)
        snapshot(NavigationStack { YouRootView(model: model) }, named: "root")
        snapshot(NavigationStack { YouRootView(model: model) }, named: "root-16e", size: CGSize(width: 390, height: 844))
        snapshot(NavigationStack { YouRootView(model: model) }.environment(\.sizeCategory, .extraExtraLarge), named: "root-xxl")
    }

    /// The AI Coach screens: goal & context, the model picker, and the key
    /// section's two states (the sheet W6 built, from here).
    @MainActor
    func testCoachSection() async {
        let model = await loaded()
        snapshot(NavigationStack { CoachProfileView(model: model) }, named: "coach-profile", size: CGSize(width: 393, height: 520))
        snapshot(NavigationStack { CoachModelPickerView(model: model) }, named: "coach-model", size: CGSize(width: 393, height: 620))
        let keyed = await loaded(hasKey: true)
        snapshot(NavigationStack { YouRootView(model: keyed) }, named: "root-with-key", size: CGSize(width: 393, height: 700))
    }

    @MainActor
    func testAccountScreens() async {
        let model = await loaded()
        snapshot(NavigationStack { AvatarPickerView(model: model) }, named: "avatar-picker")
        snapshot(NavigationStack { HeartRateZonesView(model: model) }, named: "heart-rate", size: CGSize(width: 393, height: 360))
        snapshot(NavigationStack { ChangePasswordView(model: model) }, named: "change-password", size: CGSize(width: 393, height: 400))
        snapshot(NavigationStack { DeleteAccountView(model: model) }, named: "delete-account", size: CGSize(width: 393, height: 420))
        snapshot(NavigationStack { AboutView(model: model) }, named: "about", size: CGSize(width: 393, height: 460))
    }

    /// The one-time token reveal, and the connector screen behind it.
    @MainActor
    func testTokenReveal() async {
        let model = await loaded()
        snapshot(NavigationStack { ConnectorView(model: model.connector) }, named: "connector", size: CGSize(width: 393, height: 760))
        snapshot(TokenRevealSheet(token: "apx_1f9c2e7b4d6a8c0e1f9c2e7b4d6a8c0e1f9c2e7b") {}, named: "token-reveal", size: CGSize(width: 393, height: 320))
        snapshot(NavigationStack { ConnectorGuideView(endpoint: model.connector.endpoint) }, named: "connector-guide", size: CGSize(width: 393, height: 1200))
    }

    /// The COROS screen connected and expired, and the sync confirmation sheet.
    @MainActor
    func testCorosAndSyncConfirmation() async throws {
        let model = await loaded()
        snapshot(NavigationStack { CorosView(model: model.coros) }, named: "coros-connected", size: CGSize(width: 393, height: 560))

        let expired = makeYouModel(YouTransport.healthy(corosStatus: "expired"))
        await expired.coros.refreshStatus()
        snapshot(NavigationStack { CorosView(model: expired.coros) }, named: "coros-expired", size: CGSize(width: 393, height: 360))

        let preview = try JSONDecoder().decode(SyncPreviewResponse.self, from: YouTransport.fixture("provider-preview.json"))
        snapshot(
            SyncConfirmationSheet(proposal: preview.proposals[0], remaining: 2, onKeep: {}, onFill: {}),
            named: "sync-confirm", size: CGSize(width: 393, height: 300)
        )
    }

    @MainActor
    func testActivityLogAndFeed() async {
        let model = await loaded()
        await model.activity.load()
        snapshot(NavigationStack { ActivityLogView(model: model.activity) }, named: "activity-log", size: CGSize(width: 393, height: 620))
        snapshot(NavigationStack { CalendarFeedView(model: model) }, named: "calendar-feed", size: CGSize(width: 393, height: 420))
    }
}
