import ApexCore
import ApexFeatures
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// W16 MT, opt-in like every snapshot suite:
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/TermsSnapshotTests test
final class TermsSnapshotTests: XCTestCase {
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
    private func view(_ status: TermsStatus) -> TermsUpdateView {
        TermsUpdateView(
            status: status, email: "agent@apex.local",
            termsURL: URL(string: "https://apex-training.app/terms")!, privacyURL: URL(string: "https://apex-training.app/privacy")!,
            onAccept: { nil }, onSignOut: {}
        )
    }

    /// A returning user: what they accepted before, and the versions now.
    @MainActor
    func testReturningUser() {
        let status = TermsStatus(
            accepted: .init(termsVersion: "terms-v1", privacyVersion: "privacy-v1", acceptedAt: "2026-08-29T12:00:00.000Z"),
            current: false, termsVersion: "terms-v1", privacyVersion: "privacy-v2"
        )
        snapshot(view(status), named: "terms-returning")
        snapshot(view(status).environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge), named: "terms-returning-axxxl", size: CGSize(width: 393, height: 2600))
    }

    /// No acceptance on record at all (an account from before the ledger).
    @MainActor
    func testNoAcceptanceOnRecord() {
        snapshot(view(TermsStatus(accepted: nil, current: false, termsVersion: "terms-v1", privacyVersion: "privacy-v2")), named: "terms-first")
    }
}
