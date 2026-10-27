import XCTest

/// Open sign-up against a real backend: the Local configuration's vite server
/// with Cloudflare's always-pass Turnstile test keys, and the local Supabase
/// stack. Opt-in like the snapshot tests — CI has neither — so it runs only
/// with TEST_RUNNER_APEX_LIVE_SIGNUP=1:
///
///   VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA \
///   TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
///     npx vite --mode agent --host 127.0.0.1
///   TEST_RUNNER_APEX_LIVE_SIGNUP=1 xcodebuild … -only-testing:ApexUITests/LiveSignUpUITests test
///
/// What it proves that the mock cannot: Cloudflare's widget runs inside the
/// sheet's WKWebView, `/signup-check` hands the token over the message
/// handler, and `/api/signup` accepts it. Without RESEND_API_KEY the local
/// server cannot send the mail, so its answer is the "could not send" refusal
/// — which is the server talking, after the token and the attestation passed.
final class LiveSignUpUITests: XCTestCase {
    func testTheCheckRunsInTheWebViewAndTheServerAcceptsItsToken() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["APEX_LIVE_SIGNUP"] == "1",
                          "opt-in: TEST_RUNNER_APEX_LIVE_SIGNUP=1 with the local stack up")
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest"]
        app.launch()

        let mode = app.segmentedControls["signin.mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 15))
        mode.buttons["Create account"].tap()
        let email = app.textFields["signin.email"]
        email.tap()
        email.typeText("live-signup-\(Int(Date().timeIntervalSince1970))@apex.local")
        for id in ["signup.terms", "signup.age"] {
            let toggle = app.switches[id]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5))
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        }
        app.buttons["signup.submit"].tap()

        // The sheet closes itself once the page posts a token, then the
        // server's answer lands on the form.
        let notice = app.staticTexts["signup.notice"]
        let problem = app.staticTexts["signup.problem"]
        let failed = app.staticTexts["signup.check.failed"]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !notice.exists, !problem.exists, !failed.exists { sleep(1) }
        XCTAssertFalse(failed.exists, "the check page did not load, or the widget failed")
        XCTAssertTrue(notice.exists || problem.exists, "no answer: the token never reached the app")
        if problem.exists {
            // Past the token and the attestation, only the mail step can refuse locally.
            XCTAssertTrue(problem.label.contains("could not send"), "refused before the mail step: \(problem.label)")
        }
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "live-signup-answer"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
