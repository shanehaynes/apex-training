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

    /// sign in → event → Start Workout → a ghost commits on focus → the first
    /// saves fail, the chip says so, the retry clears it → Finish → confirm →
    /// summary streams → Back. All on fixtures (W4).
    func testTrackerOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockFailOnce", "save", "3"]
        app.launch()
        signIn(app)

        let card = app.buttons["event.card.Fixture Push Day"]
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        card.tap()
        let start = app.buttons["schedule.event.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertEqual(start.label, "View / Edit Workout", "the fixture occurrence is completed")
        start.tap()

        let title = app.staticTexts["tracker.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 20))
        XCTAssertEqual(title.label, "Fixture Push Day")
        XCTAssertTrue(app.staticTexts["tracker.elapsed"].exists)
        attach(app, name: "07-tracker")

        // Focus on the shadowed row commits last time's values.
        let weight2 = app.textFields["tracker.input.fx-press.2.weight"]
        XCTAssertTrue(weight2.waitForExistence(timeout: 10))
        weight2.tap()
        XCTAssertEqual(weight2.value as? String, "110 lb")
        app.buttons["tracker.keyboard.done"].tap()

        // The first saves are refused: the chip counts the set, then the retry clears it.
        let chip = app.otherElements["tracker.sync"].firstMatch
        let syncText = app.staticTexts["1 set pending sync"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10) || syncText.waitForExistence(timeout: 10))
        attach(app, name: "08-tracker-pending")
        let cleared = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: syncText)
        wait(for: [cleared], timeout: 30)

        // Finish: set 1 was never touched, so the gate asks first.
        app.buttons["tracker.finish"].tap()
        let finishAnyway = app.buttons["Finish anyway"]
        XCTAssertTrue(finishAnyway.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["1 planned set unlogged — recorded as 0."].exists)
        attach(app, name: "09-tracker-confirm")
        finishAnyway.tap()

        let summary = app.otherElements["tracker.summary"].firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 20) || app.staticTexts["Workout Complete"].waitForExistence(timeout: 20))
        let coach = app.staticTexts["Strong session — a new estimated 1RM on Fixture Press."]
        XCTAssertTrue(coach.waitForExistence(timeout: 20), "the fixture stream renders")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'est. 1RM 132'")).firstMatch.exists)
        attach(app, name: "10-tracker-summary")

        app.buttons["tracker.summary.back"].tap()
        XCTAssertTrue(app.buttons["event.card.Fixture Push Day"].waitForExistence(timeout: 20))
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

    // MARK: - W6 · the coach

    /// sign in → Coach → send → streamed text → confirmation card → Confirm →
    /// tools-off follow-up → the conversation list, all on fixtures. The mock
    /// streams `chat-stream.ndjson` line by line and answers `/api/coach-tool`.
    func testCoachOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockHasKey"]
        app.launch()
        signIn(app)

        let coachTab = app.tabBars.buttons["Coach"]
        XCTAssertTrue(coachTab.waitForExistence(timeout: 20))
        coachTab.tap()

        // The header carries the model badge (U31) and the thread is empty.
        XCTAssertTrue(app.staticTexts["coach.model"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["coach.model"].label, "Opus 4.8")
        XCTAssertTrue(app.otherElements["coach.empty"].exists)
        attach(app, name: "11-coach-empty")

        let composer = app.textFields["coach.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("skip next week")
        app.buttons["coach.send"].tap()

        // The card replaces the composer once the stream ends; the label is the server's.
        let card = app.otherElements["coach.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["coach.card.label"].label, "Delete: Fixture Push Day · 2026-09-29 (this instance)")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Clearing it'")).firstMatch.exists)
        XCTAssertFalse(app.textFields["coach.composer"].exists)
        attach(app, name: "12-coach-card")

        app.buttons["coach.card.confirm"].tap()
        let followUp = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Done — Fixture Push Day'")).firstMatch
        XCTAssertTrue(followUp.waitForExistence(timeout: 20))
        XCTAssertTrue(app.textFields["coach.composer"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["coach.card"].exists)
        attach(app, name: "13-coach-followup")

        // The thread is a stored conversation, titled from its first message.
        app.buttons["coach.conversations"].tap()
        XCTAssertTrue(app.otherElements["coach.conversations.list"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["skip next week"].waitForExistence(timeout: 10))
        attach(app, name: "14-coach-conversations")
    }

    /// Without a key the tab opens on the key-setup state; saving one through
    /// the sheet unblocks the composer and the next turn streams.
    func testCoachKeySetupOnFixtures() {
        let app = launch(mock: true)
        signIn(app)

        let coachTab = app.tabBars.buttons["Coach"]
        XCTAssertTrue(coachTab.waitForExistence(timeout: 20))
        coachTab.tap()

        let add = app.buttons["coach.keysetup.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["coach.composer"].isEnabled)
        attach(app, name: "15-coach-key-setup")

        add.tap()
        let field = app.secureTextFields["key.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("sk-ant-api03-mock-key-0000000000")
        app.buttons["key.save"].tap()

        // The sheet closes, the profile now reports a key, the thread is open.
        XCTAssertTrue(app.otherElements["coach.empty"].waitForExistence(timeout: 10))
        let composer = app.textFields["coach.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(composer.isEnabled)
        composer.tap()
        composer.typeText("hi")
        app.buttons["coach.send"].tap()
        XCTAssertTrue(app.otherElements["coach.card"].waitForExistence(timeout: 20))
        attach(app, name: "16-coach-key-saved")
    }

    /// sign in → the day → rename the run inline → delete this day only on the
    /// series → link a circuit exercise into the superset → delete the run →
    /// the "+" opens the builder. All on fixtures; the mock replays every write
    /// into the next schedule read (W7).
    func testEventEditsOnFixtures() {
        let app = launch(mock: true)
        signIn(app)
        let run = app.buttons["event.card.Fixture Run"]
        XCTAssertTrue(run.waitForExistence(timeout: 20))

        // Rename inline: tap the title, retype, submit.
        run.tap()
        let title = app.buttons["schedule.event.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        title.tap()
        let field = app.textFields["schedule.event.title.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Fixture Run".count) + "Fixture Run PM\n")
        let renamed = app.buttons["schedule.event.title"]
        let renamedShows = expectation(for: NSPredicate(format: "label == %@", "Fixture Run PM"), evaluatedWith: renamed)
        wait(for: [renamedShows], timeout: 10)
        attach(app, name: "17-renamed")

        // Delete the one-off: the confirm names the workout, the card leaves the day.
        let sheet = app.scrollViews.firstMatch
        let deleteLink = app.buttons["schedule.event.delete"]
        var swipes = 0
        while !deleteLink.isHittable, swipes < 6 { sheet.swipeUp(); swipes += 1 }
        deleteLink.tap()
        let confirm = app.buttons["schedule.event.delete.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertEqual(confirm.label, "Delete workout")
        attach(app, name: "18-delete-one-off")
        confirm.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["event.card.Fixture Run PM"])
        wait(for: [gone], timeout: 10)
        XCTAssertFalse(app.buttons["event.card.Fixture Run"].exists)

        // The series: "This day only" skips the occurrence; the other days stay.
        app.buttons["event.card.Fixture Push Day"].tap()
        XCTAssertTrue(app.buttons["schedule.event.title"].waitForExistence(timeout: 10))
        let seriesDelete = app.buttons["schedule.event.delete"]
        swipes = 0
        while !seriesDelete.isHittable, swipes < 6 { app.scrollViews.firstMatch.swipeUp(); swipes += 1 }
        seriesDelete.tap()
        let thisDay = app.buttons["schedule.event.delete.confirm"]
        XCTAssertTrue(thisDay.waitForExistence(timeout: 5))
        XCTAssertEqual(thisDay.label, "This day only")
        XCTAssertTrue(app.buttons["schedule.event.delete.series"].exists)
        attach(app, name: "19-delete-this-day")
        thisDay.tap()
        let skipped = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["event.card.Fixture Push Day"])
        wait(for: [skipped], timeout: 10)
        // Next week's occurrence is still on the calendar.
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()
        XCTAssertTrue(app.buttons["event.card.Fixture Push Day"].waitForExistence(timeout: 10))
        app.buttons["Today"].tap()

        // Edit exercises on the circuit: link the plank into the superset, save, reopen.
        app.buttons["event.card.Fixture Circuit"].tap()
        let editExercises = app.buttons["schedule.event.edit.exercises"]
        XCTAssertTrue(editExercises.waitForExistence(timeout: 10))
        editExercises.tap()
        let editor = app.otherElements["schedule.event.exercises"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        let link = app.buttons["editor.link.fx-c3"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        XCTAssertEqual(link.label, "Link with above")
        link.tap()
        XCTAssertEqual(link.label, "Unlink")
        attach(app, name: "20-edit-exercises")
        app.buttons["editor.save"].tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: editor)
        wait(for: [closed], timeout: 10)
        app.buttons["event.card.Fixture Circuit"].tap()
        XCTAssertTrue(app.buttons["schedule.event.title"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["Superset A"].waitForExistence(timeout: 5))
        attach(app, name: "21-superset-of-three")
        app.buttons["Close"].firstMatch.tap()

        // The "+" opens the builder on the selected day.
        let add = app.buttons["schedule.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        XCTAssertTrue(app.otherElements["builder"].waitForExistence(timeout: 10) || app.staticTexts["Add Workout"].waitForExistence(timeout: 5))
        attach(app, name: "22-builder-entry")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}

/// The auth links (D-020, architecture.md §3) on the mock: an invite hand-off
/// lands on set-password and a password signs in; a spent link explains itself.
final class AuthLinkUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchMock() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient"]
        app.launch()
        return app
    }

    func testInviteHandOffLandsOnSetPasswordAndSignsIn() {
        let app = launchMock()
        XCTAssertTrue(app.textFields["signin.email"].waitForExistence(timeout: 10))

        XCUIDevice.shared.system.open(URL(string:
            "apextraining://auth#access_token=AT&refresh_token=RT&type=invite&expires_in=3600&token_type=bearer")!)
        let newPassword = app.secureTextFields["setpassword.new"]
        XCTAssertTrue(newPassword.waitForExistence(timeout: 10))
        attach(app, name: "09-set-password")

        newPassword.tap()
        newPassword.typeText("correct-horse-battery")
        let confirm = app.secureTextFields["setpassword.confirm"]
        confirm.tap()
        confirm.typeText("correct-horse-battery")
        // The invitee has never accepted on the web: the toggle is required.
        let terms = app.switches["setpassword.terms"]
        XCTAssertTrue(terms.exists)
        terms.tap()
        app.buttons["setpassword.submit"].tap()

        XCTAssertTrue(app.tabBars.buttons["Schedule"].waitForExistence(timeout: 20))
        attach(app, name: "10-after-set-password")
    }

    func testSpentLinkExplainsItself() {
        let app = launchMock()
        XCTAssertTrue(app.textFields["signin.email"].waitForExistence(timeout: 10))
        XCUIDevice.shared.system.open(URL(string:
            "apextraining://auth#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")!)
        let toast = app.staticTexts["toast.failure"]
        XCTAssertTrue(toast.waitForExistence(timeout: 10))
        XCTAssertTrue(toast.label.contains("already been used"), toast.label)
        XCTAssertTrue(app.textFields["signin.email"].exists)
        attach(app, name: "11-spent-link")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
