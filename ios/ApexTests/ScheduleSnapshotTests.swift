import SnapshotTesting
import SwiftUI
import XCTest
import ApexFeatures
import ApexUI

/// Opt-in, not a CI gate.
///
/// Snapshot bytes are a function of the OS's own text rendering and chrome, so a
/// suite recorded on this Mac goes red on a CI runner for reasons that have
/// nothing to do with the change under review — and a permanently red suite is a
/// suite everybody learns to ignore. A Mac session records and reviews these;
/// ios/scripts/screenshots.sh produces the visual evidence a PR carries.
///
///   APEX_SNAPSHOTS=1 xcodebuild ... test
final class ScheduleSnapshotTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1",
            "set APEX_SNAPSHOTS=1 to run snapshot tests"
        )
    }

    @MainActor
    func testEmptyScheduleTab() {
        ApexFonts.register()
        assertSnapshot(of: ScheduleTab(), as: .image(layout: .device(config: .iPhone13Pro)))
    }

    @MainActor
    func testSignInScreen() {
        ApexFonts.register()
        let view = SignInView(onSignIn: { _, _ in nil }, onForgotPassword: { _ in nil })
        assertSnapshot(of: view, as: .image(layout: .device(config: .iPhone13Pro)))
    }
}
