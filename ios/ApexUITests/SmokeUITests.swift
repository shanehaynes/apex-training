import XCTest

/// The launch-to-tabs smoke.
///
/// Two flavours. `-apexMockClient` runs the whole Schedule path against the
/// bundled fixtures with no backend and no Keychain — the path CI can take on an
/// unsigned build. The live flavour signs in against the local stack and skips
/// when none is reachable.
final class SmokeUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(mock: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest"]
        if mock { app.launchArguments += ["-apexMockClient"] }
        app.launch()
        return app
    }

    private func signIn(_ app: XCUIApplication) {
        let email = app.textFields["signin.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("agent@apex.local")
        let password = app.secureTextFields["signin.password"]
        password.tap()
        password.typeText("apex-agent-password")
        app.buttons["Sign in"].tap()
    }

    func testSignInScreenOffersAutoFillableFields() {
        let app = launch(mock: false)
        let email = app.textFields["signin.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertTrue(app.secureTextFields["signin.password"].exists)
        XCTAssertTrue(app.buttons["Sign in"].exists)

        // Invite-only has to be stated, not implied (App Store 5.1.1).
        XCTAssertTrue(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] 'invite-only'")
        ).firstMatch.exists)

        attach(app, name: "01-sign-in")
    }

    /// sign in → today → month → day sheet → event → complete, all on fixtures.
    func testScheduleOnFixtures() {
        let app = launch(mock: true)
        signIn(app)

        let schedule = app.tabBars.buttons["Schedule"]
        XCTAssertTrue(schedule.waitForExistence(timeout: 20))
        for tab in ["Schedule", "Coach", "Analytics", "You"] {
            XCTAssertTrue(app.tabBars.buttons[tab].exists, "missing tab: \(tab)")
        }

        // Day: the fixture day carries four events.
        let pushDay = app.buttons["event.card.Fixture Push Day"]
        XCTAssertTrue(pushDay.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["event.card.Fixture Run"].exists)
        XCTAssertTrue(app.staticTexts["schedule.meals"].label.contains("1114 kcal"))
        attach(app, name: "02-day")

        // Month: the fourth event is an overflow chip; it opens the day sheet.
        app.buttons["Month"].tap()
        let more = app.buttons["schedule.month.more.2026-09-08"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        attach(app, name: "03-month")
        more.tap()
        XCTAssertTrue(app.buttons["event.card.Fixture Run"].waitForExistence(timeout: 10))
        attach(app, name: "04-day-sheet")

        // Event: the synced run shows its provider badge; completing it flips the button.
        app.buttons["event.card.Fixture Run"].tap()
        XCTAssertTrue(app.staticTexts["schedule.event.title"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["schedule.event.synced"].waitForExistence(timeout: 10)
            || app.staticTexts["Synced from COROS"].waitForExistence(timeout: 5))
        attach(app, name: "05-event")
        let complete = app.buttons["schedule.event.complete"]
        XCTAssertTrue(complete.exists)
        XCTAssertEqual(complete.label, "Mark as Complete")
        complete.tap()
        let flipped = expectation(for: NSPredicate(format: "label == %@", "Completed"), evaluatedWith: complete)
        wait(for: [flipped], timeout: 10)
        attach(app, name: "06-completed")
    }

    /// The live flavour: a real sign-in against the local stack.
    func testSignInRevealsTheFourTabs() throws {
        let app = launch(mock: false)
        signIn(app)

        let schedule = app.tabBars.buttons["Schedule"]
        guard schedule.waitForExistence(timeout: 20) else {
            throw XCTSkip("no local Supabase stack reachable from this simulator")
        }
        for tab in ["Schedule", "Coach", "Analytics", "You"] {
            XCTAssertTrue(app.tabBars.buttons[tab].exists, "missing tab: \(tab)")
        }
        attach(app, name: "07-schedule-live")
        app.tabBars.buttons["You"].tap()
        attach(app, name: "08-you")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
