import ApexActivity
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// Opt-in, like the other snapshot suites:
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/ActivitySnapshotTests test
///
/// Every snapshot is in the `.done` phase: a running `Text(timerInterval:)`
/// redraws each second and can never match a stored image. The running phase
/// is proved on the simulator (W12 brief, session log).
final class ActivitySnapshotTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    private static let started = Date(timeIntervalSince1970: 1_790_080_920)

    private static func attributes(title: String) -> TrackerActivityAttributes {
        TrackerActivityAttributes(title: title, eventId: "ios-fixture-weekly__2026-09-22", eventDate: "2026-09-22")
    }

    private static let done = TrackerActivityAttributes.ContentState(
        startedAt: started, exerciseCount: 6, phase: .done(totalSeconds: 42 * 60 + 10)
    )

    private static let longTitle = "Morning Movement Practice and Extended Mobility Block — Week 12 Deload"

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize) {
        ApexFonts.register()
        let framed = view
            .frame(width: size.width, height: size.height)
            .background(Color.black)
            .preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    /// The Lock Screen banner at the width iOS gives it on a 393pt phone.
    @MainActor
    func testLockScreenBanner() {
        snapshot(
            TrackerActivityPreviews.lockScreen(attributes: Self.attributes(title: "Morning Movement"), state: Self.done),
            named: "lock-screen", size: CGSize(width: 361, height: 120)
        )
    }

    /// Two lines then tail truncation — the rule in TrackerActivityViews.
    @MainActor
    func testLockScreenBannerLongTitle() {
        snapshot(
            TrackerActivityPreviews.lockScreen(attributes: Self.attributes(title: Self.longTitle), state: Self.done),
            named: "lock-screen-long-title", size: CGSize(width: 361, height: 120)
        )
    }

    /// The expanded island: one line, tail-truncated, timer never squeezed.
    @MainActor
    func testExpandedIslandLongTitle() {
        snapshot(
            TrackerActivityPreviews.expanded(attributes: Self.attributes(title: Self.longTitle), state: Self.done),
            named: "expanded-long-title", size: CGSize(width: 371, height: 140)
        )
    }

    @MainActor
    func testExpandedIsland() {
        snapshot(
            TrackerActivityPreviews.expanded(attributes: Self.attributes(title: "Morning Movement"), state: Self.done),
            named: "expanded", size: CGSize(width: 371, height: 140)
        )
    }
}
