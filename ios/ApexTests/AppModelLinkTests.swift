import ApexAuth
import ApexCore
import ApexUI
import Foundation
import XCTest
@testable import Apex

/// Auth deep links through `AppModel.open(_:)` (#201).
///
/// A `#access_token=…&refresh_token=…` fragment is a whole session, and any web
/// page, QR code or other app can hand the app one. Taking it while somebody is
/// signed in swaps the account around `signOut()` — session fixation — so the
/// refusal is a *state* check. It is deliberately not an origin check: the web
/// invite hand-off (`src/lib/auth/landing.ts`, D-020) builds
/// `apextraining://auth#…` itself, and demanding the universal-link origin would
/// break invite acceptance on a phone.
final class AppModelLinkTests: XCTestCase {
    private static let refusal = "Sign out first to use a sign-in link for another account."
    private static let tokenLink = URL(
        string: "apextraining://auth#access_token=attacker-access&refresh_token=attacker-refresh&type=invite"
    )!

    /// The bus is a singleton and toasts linger for four seconds, so tests read
    /// what landed after a mark rather than the whole stack.
    @MainActor
    private func toasts(after mark: Int) -> [String] {
        Array(ToastBus.shared.toasts.dropFirst(mark)).map(\.message)
    }

    @MainActor
    private func signedInModel() async -> AppModel {
        let model = AppModel(mock: MockEnvironment())
        _ = await model.signIn(email: "first@apex.local", password: "whatever")
        guard case .signedIn = model.state else {
            XCTFail("the mock sign-in should have produced a session")
            return model
        }
        return model
    }

    @MainActor
    func testATokenLinkIsRefusedWhileSignedIn() async {
        let model = await signedInModel()
        let mark = ToastBus.shared.toasts.count

        await model.open(Self.tokenLink)

        // `type=invite` would otherwise put the mock on set-password, so an
        // unchanged `.signedIn` is proof the tokens were never handled.
        guard case .signedIn(_, let email) = model.state else {
            return XCTFail("a token link must not move a signed-in user off their session")
        }
        XCTAssertEqual(email, "first@apex.local", "the session must still be the one that was signed in")
        XCTAssertEqual(toasts(after: mark), [Self.refusal])
    }

    @MainActor
    func testATokenLinkStillSignsInWhenSignedOut() async {
        let model = AppModel(mock: MockEnvironment())
        let mark = ToastBus.shared.toasts.count

        await model.open(Self.tokenLink)

        // The whole point of D-020: an invite fragment from the web still lands.
        guard case .needsPassword = model.state else {
            return XCTFail("an invite link on a signed-out app must reach set-password")
        }
        XCTAssertEqual(toasts(after: mark), [], "nothing was refused")
    }

    @MainActor
    func testAPKCECodeLinkIsUnaffectedWhileSignedIn() async {
        let model = await signedInModel()
        let mark = ToastBus.shared.toasts.count

        // `?code=` is the flow the app itself started; it is not refused.
        await model.open(URL(string: "apextraining://auth?code=pkce-code")!)

        guard case .signedIn(_, let email) = model.state else {
            return XCTFail("a code link should have been handled")
        }
        XCTAssertEqual(email, "agent@apex.local", "the mock's code path signs in as its fixture user")
        XCTAssertEqual(toasts(after: mark), [], "nothing was refused")
    }

    @MainActor
    func testAnErrorLinkIsUnaffectedWhileSignedIn() async {
        let model = await signedInModel()
        let mark = ToastBus.shared.toasts.count

        await model.open(URL(string: "apextraining://auth#error=access_denied&error_code=otp_expired")!)

        // A spent link is a reason, not a sign-out — and not the refusal.
        guard case .signedIn = model.state else {
            return XCTFail("an error link must not end the session")
        }
        XCTAssertEqual(toasts(after: mark), [AuthLinkError.expiredMessage])
    }
}
