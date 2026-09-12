import XCTest
@testable import ApexCore

final class DeepLinkTests: XCTestCase {
    private func parse(_ s: String) -> DeepLink? { DeepLink.parse(URL(string: s)!) }

    // MARK: - src/lib/auth/__tests__/linkError.test.ts, verbatim

    func testCleanLandingHasNoError() {
        XCTAssertNil(AuthLinkError.parse(fragment: "", query: ""))
        XCTAssertNil(AuthLinkError.parse(fragment: "#access_token=abc&type=invite", query: nil))
    }

    func testSpentInviteBecomesActionable() {
        let result = AuthLinkError.parse(
            fragment: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=",
            query: nil)
        XCTAssertEqual(result?.code, "otp_expired")
        XCTAssertTrue(result!.message.contains("expired, or it has already been used"))
        XCTAssertTrue(result!.message.contains("fresh invite"))
    }

    func testSpentLinkWithoutCode() {
        let result = AuthLinkError.parse(fragment: "#error=access_denied&error_description=Email+link+is+invalid+or+has+expired", query: nil)
        XCTAssertTrue(result!.message.contains("fresh invite"))
    }

    func testPassesThroughUnknownFailures() {
        XCTAssertEqual(
            AuthLinkError.parse(fragment: "#error=server_error&error_description=Database+error+saving+new+user", query: nil),
            AuthLinkError(code: nil, message: "Database error saving new user"))
    }

    func testNamesTheErrorWithoutADescription() {
        XCTAssertEqual(AuthLinkError.parse(fragment: "#error=access_denied", query: nil)?.message, "Sign-in link failed: access_denied")
    }

    func testReadsTheQueryStringToo() {
        XCTAssertEqual(AuthLinkError.parse(fragment: "", query: "?error_code=otp_expired&error_description=Email+link+is+invalid")?.code, "otp_expired")
    }

    func testPrefersTheFragment() {
        XCTAssertEqual(
            AuthLinkError.parse(fragment: "#error_description=from+the+fragment", query: "?error_description=from+the+query")?.message,
            "from the fragment")
    }

    // MARK: - URL routing

    func testUniversalLinkWithCode() {
        XCTAssertEqual(parse("https://apextrainingcalendar.vercel.app/auth/callback?code=abc123"), .authCode(code: "abc123", type: nil))
        XCTAssertEqual(parse("apextraining://auth?code=abc123"), .authCode(code: "abc123", type: nil))
        XCTAssertEqual(parse("https://apextrainingcalendar.vercel.app/auth/callback?code=abc&type=recovery"),
                       .authCode(code: "abc", type: .recovery))
    }

    func testInviteHandOffFragment() {
        let link = parse("apextraining://auth#access_token=AT&refresh_token=RT&type=invite&expires_in=3600&token_type=bearer")
        XCTAssertEqual(link, .authTokens(accessToken: "AT", refreshToken: "RT", type: .invite))
        if case .authTokens(_, _, let type) = link! { XCTAssertTrue(type!.needsPassword) }
        XCTAssertEqual(parse("https://apextrainingcalendar.vercel.app/auth/callback#access_token=AT&refresh_token=RT&type=recovery"),
                       .authTokens(accessToken: "AT", refreshToken: "RT", type: .recovery))
        XCTAssertEqual(parse("apextraining://auth#access_token=AT&refresh_token=RT"),
                       .authTokens(accessToken: "AT", refreshToken: "RT", type: nil))
    }

    func testIncompleteFragmentIsAnError() {
        guard case .authError(let error) = parse("apextraining://auth#access_token=AT&type=invite") else {
            return XCTFail("expected an error")
        }
        XCTAssertTrue(error.message.contains("incomplete"))
    }

    func testExpiredFragmentOnTheScheme() {
        let link = parse("apextraining://auth#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")
        guard case .authError(let error) = link else { return XCTFail("expected an error") }
        XCTAssertEqual(error.code, "otp_expired")
    }

    func testEmptyAuthLinkIsNil() {
        XCTAssertNil(parse("apextraining://auth"))
        XCTAssertNil(parse("https://apextrainingcalendar.vercel.app/auth/callback"))
    }

    func testOtherHostsAndPathsAreNotOurs() {
        XCTAssertNil(parse("https://example.com/auth/callback?code=x"))
        XCTAssertNil(parse("https://apextrainingcalendar.vercel.app/"))
        XCTAssertNil(parse("https://apextrainingcalendar.vercel.app/auth/other?code=x"))
        XCTAssertNil(parse("otherscheme://auth?code=x"))
    }

    func testAppRoutes() {
        XCTAssertEqual(parse("https://apextrainingcalendar.vercel.app/app/event/ios-fixture-weekly__2026-09-08/2026-09-08"),
                       .event(id: "ios-fixture-weekly__2026-09-08", date: "2026-09-08"))
        XCTAssertEqual(parse("https://apextrainingcalendar.vercel.app/app/library/def-1"), .library(definitionId: "def-1"))
        XCTAssertNil(parse("https://apextrainingcalendar.vercel.app/app/event/only-id"))
    }

    /// The Live Activity's tap URL (W12), and the same routes on the scheme.
    func testTrackerRouteOnTheSchemeAndTheOrigin() {
        XCTAssertEqual(parse("apextraining://app/tracker/ios-fixture-weekly__2026-09-22/2026-09-22"),
                       .tracker(id: "ios-fixture-weekly__2026-09-22", date: "2026-09-22"))
        XCTAssertEqual(parse("https://apextrainingcalendar.vercel.app/app/tracker/e/2026-09-22"), .tracker(id: "e", date: "2026-09-22"))
        XCTAssertEqual(parse("apextraining://app/event/e/2026-09-22"), .event(id: "e", date: "2026-09-22"))
        XCTAssertEqual(parse("apextraining://app/library/def-1"), .library(definitionId: "def-1"))
        XCTAssertNil(parse("apextraining://app/tracker/only-id"))
        XCTAssertNil(parse("apextraining://app/tracker/e/2026-09-22/extra"))
        XCTAssertNil(parse("apextraining://app/"))
        XCTAssertNil(parse("apextraining://tracker/e/2026-09-22"), "the scheme's routes live under the app host")
    }

    func testProviderLinks() {
        XCTAssertEqual(parse("apextraining://connected?provider=coros"), .connected(provider: "coros"))
        XCTAssertEqual(parse("apextraining://connect_error?provider=coros&message=denied"),
                       .connectError(provider: "coros", message: "denied"))
    }

    /// W11: /api/provider-callback sends a `reason` code, not `message`. The
    /// older keys stay in the chain, and `reason` wins when more than one is
    /// present.
    func testConnectErrorPrefersTheCallbacksReasonCode() {
        for reason in ["denied", "missing_code", "expired", "exchange_failed"] {
            XCTAssertEqual(parse("apextraining://connect_error?provider=coros&reason=\(reason)"),
                           .connectError(provider: "coros", message: reason))
        }
        XCTAssertEqual(parse("apextraining://connect_error?provider=coros&reason=expired&message=old"),
                       .connectError(provider: "coros", message: "expired"))
        // A bare failure still parses — the app shows its generic copy.
        XCTAssertEqual(parse("apextraining://connect_error"),
                       .connectError(provider: nil, message: nil))
    }
}
