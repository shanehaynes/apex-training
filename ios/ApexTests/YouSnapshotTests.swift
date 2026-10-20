import ApexCore
import ApexFeatures
import ApexHealth
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/YouSnapshotTests test
final class YouSnapshotTests: XCTestCase {
    /// The voice toggle (W17) is a device preference the UI smoke writes on
    /// every launch of the same bundle, so the roots pin it off and the voice
    /// rows pin it on; whatever was there comes back after.
    private var previousVoiceToggle: Any?

    override func setUpWithError() throws {
        previousVoiceToggle = UserDefaults.standard.object(forKey: TrackerModel.voicePreferenceKey)
        UserDefaults.standard.set(false, forKey: TrackerModel.voicePreferenceKey)
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    override func tearDown() {
        if let previousVoiceToggle {
            UserDefaults.standard.set(previousVoiceToggle, forKey: TrackerModel.voicePreferenceKey)
        } else {
            UserDefaults.standard.removeObject(forKey: TrackerModel.voicePreferenceKey)
        }
        super.tearDown()
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
        // ux-review §3.10: the rows used to read "Training bloc…" here.
        snapshot(
            NavigationStack { YouRootView(model: model) }.environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge),
            named: "root-axxxl", size: CGSize(width: 393, height: 1400)
        )
    }

    /// The AI Coach screens: goal & context, the model picker, and the key
    /// section's two states (the sheet W6 built, from here).
    /// W17: the Training section with "Log sets by voice" and the voice-log
    /// rows, tall enough to show them under the sections above.
    @MainActor
    func testTrainingVoiceRows() async {
        UserDefaults.standard.set(true, forKey: TrackerModel.voicePreferenceKey)
        let model = await loaded()
        snapshot(
            NavigationStack { YouRootView(model: model, voiceJournal: MemoryVoiceJournalStore()) },
            named: "you-training-voice", size: CGSize(width: 393, height: 1300)
        )
        snapshot(
            NavigationStack { YouRootView(model: model, voiceJournal: MemoryVoiceJournalStore()) }
                .environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge),
            named: "you-training-voice-axxxl", size: CGSize(width: 393, height: 2600)
        )
    }

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
        snapshot(
            NavigationStack { ConnectorView(model: model.connector) }.environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge),
            named: "connector-axxxl", size: CGSize(width: 393, height: 1100)
        )
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

    /// W16 M1: the Integrations row and You → Apple Health writing, off and
    /// refused by Health.
    @MainActor
    func testAppleHealth() async {
        let suite = "apex.snapshots.health"
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        func health(_ state: HealthAuthorization, on: Bool, owner: String) -> HealthServices {
            let preferences = HealthPreferences(owner: owner, suiteName: suite)
            preferences.setWritesWorkouts(on)
            return HealthServices(store: FakeHealthStore(authorization: state), preferences: preferences)
        }

        let writing = makeYouModel(YouTransport.healthy(hasKey: true), health: health(.authorized, on: true, owner: "a"))
        await writing.start()
        await writing.connector.load()
        snapshot(NavigationStack { YouRootView(model: writing) }, named: "root-with-health", size: CGSize(width: 393, height: 1400))
        let screen = try! XCTUnwrap(writing.health)
        snapshot(NavigationStack { AppleHealthView(model: screen) }, named: "apple-health", size: CGSize(width: 393, height: 520))

        let off = makeYouModel(YouTransport.healthy(), health: health(.notDetermined, on: false, owner: "b"))
        snapshot(NavigationStack { AppleHealthView(model: off.health!) }, named: "apple-health-off", size: CGSize(width: 393, height: 520))

        let denied = makeYouModel(YouTransport.healthy(), health: health(.denied, on: true, owner: "c"))
        snapshot(NavigationStack { AppleHealthView(model: denied.health!) }, named: "apple-health-denied", size: CGSize(width: 393, height: 620))
    }

    @MainActor
    func testActivityLogAndFeed() async {
        let model = await loaded()
        await model.activity.load()
        snapshot(NavigationStack { ActivityLogView(model: model.activity) }, named: "activity-log", size: CGSize(width: 393, height: 620))
        snapshot(NavigationStack { CalendarFeedView(model: model) }, named: "calendar-feed", size: CGSize(width: 393, height: 420))
    }
}
