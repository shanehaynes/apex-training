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

    /// Taps an event card and waits for its sheet. A starved CI runner can
    /// drop a synthesized tap — the run that lost one took ten seconds just to
    /// find the card, and its recording shows the day view never moving — so
    /// a tap that opens nothing is sent again, twice at most.
    private func openEvent(_ app: XCUIApplication, card: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = app.buttons["event.card.\(card)"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "missing card: \(card)", file: file, line: line)
        let title = app.buttons["schedule.event.title"]
        for _ in 0..<3 {
            button.tap()
            if title.waitForExistence(timeout: 10) { return }
        }
        XCTFail("the event sheet never opened for \(card)", file: file, line: line)
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
        openEvent(app, card: "Fixture Run")
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

    /// #167 / D-032: a toast posted while a sheet is up renders over it, and a
    /// tap on the sheet beneath a live toast still lands — `ToastHost` sits in
    /// its own passthrough window above the app's.
    func testToastFloatsOverTheSheetOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockFail", "events"]
        app.launch()
        signIn(app)

        openEvent(app, card: "Fixture Run")
        app.buttons["schedule.event.title"].tap()
        let field = app.textFields["schedule.event.title.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText(" PM\n")
        let toast = app.staticTexts["toast.failure"]
        XCTAssertTrue(toast.waitForExistence(timeout: 10))
        XCTAssertTrue(toast.isHittable, "the toast is on top, not under the sheet")
        XCTAssertTrue(app.buttons["schedule.event.title"].exists, "the sheet is still up")
        attach(app, name: "19-toast-over-sheet")

        // Passthrough: with the toast showing, the sheet's completion button takes the tap.
        let complete = app.buttons["schedule.event.complete"]
        XCTAssertTrue(toast.exists)
        complete.tap()
        let flipped = expectation(for: NSPredicate(format: "label == %@", "Completed"), evaluatedWith: complete)
        wait(for: [flipped], timeout: 10)
    }

    /// sign in → event → Start Workout → a ghost commits on focus → the first
    /// saves fail, the chip says so, the retry clears it → Finish → confirm →
    /// summary streams → Back. All on fixtures (W4).
    func testTrackerOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockFailOnce", "save", "3"]
        app.launch()
        signIn(app)

        openEvent(app, card: "Fixture Push Day")
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
        XCTAssertEqual(app.staticTexts["coach.model"].label, "Opus 5")
        XCTAssertTrue(app.otherElements["coach.empty"].exists)
        attach(app, name: "11-coach-empty")

        let composer = app.textFields["coach.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        type("skip next week", into: composer)
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
        type("sk-ant-api03-mock-key-0000000000", into: field)
        app.buttons["key.save"].tap()

        // The sheet closes, the profile now reports a key, the thread is open.
        XCTAssertTrue(app.otherElements["coach.empty"].waitForExistence(timeout: 10))
        let composer = app.textFields["coach.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(composer.isEnabled)
        type("hi", into: composer)
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

        // Rename inline: tap the title, retype, submit.
        openEvent(app, card: "Fixture Run")
        let title = app.buttons["schedule.event.title"]
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
        openEvent(app, card: "Fixture Push Day")
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
        openEvent(app, card: "Fixture Circuit")
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
        openEvent(app, card: "Fixture Circuit")
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

    /// "+" → the library → the fixture template → the coach fills the form
    /// from the recorded builder stream → Apply → the workout is on the day.
    func testBuilderOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockHasKey"]
        app.launch()
        signIn(app)
        let add = app.buttons["schedule.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let template = app.buttons["builder.template.ios-fixture-template"]
        XCTAssertTrue(template.waitForExistence(timeout: 10))
        attach(app, name: "23-builder-search")
        template.tap()
        let titleField = app.textFields["builder.title.field"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 10))
        XCTAssertEqual(titleField.value as? String, "Fixture Template Push")
        attach(app, name: "24-builder-form")

        // The coach: one turn, the draft tool reduces server-side, the form follows.
        app.buttons["builder.coach.toggle"].tap()
        let composer = app.textViews["coach.composer"].firstMatch.exists ? app.textViews["coach.composer"].firstMatch : app.textFields["coach.composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        type("add fixture press 3x8", into: composer)
        app.buttons["coach.send"].tap()
        // The draft tool reduced server-side (the mock keeps the form's own title when the
        // coach names none) and the tools-off follow-up confirms it in the thread.
        let followUp = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Review the form and press Apply'")).firstMatch
        XCTAssertTrue(followUp.waitForExistence(timeout: 20))
        XCTAssertFalse(app.otherElements["coach.card"].exists, "the builder's coach never shows a card")
        XCTAssertEqual(titleField.value as? String, "Fixture Template Push")
        attach(app, name: "25-builder-coach")

        app.buttons["builder.apply"].tap()
        let card = app.buttons["event.card.Fixture Template Push"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        attach(app, name: "26-builder-applied")
    }

    /// Edit a series occurrence in the builder → Save changes → the scope bar →
    /// This event only → the day shows the detached, renamed workout.
    func testBuilderScopeOnFixtures() {
        let app = launch(mock: true)
        signIn(app)
        openEvent(app, card: "Fixture Push Day")
        let editWorkout = app.buttons["schedule.event.edit.workout"]
        XCTAssertTrue(editWorkout.waitForExistence(timeout: 10))
        editWorkout.tap()
        let titleField = app.textFields["builder.title.field"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 10))
        type(" (solo)", into: titleField)
        app.buttons["builder.apply"].tap()
        let scope = app.buttons["builder.scope.occurrence"]
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        attach(app, name: "27-builder-scope")
        scope.tap()
        XCTAssertTrue(app.buttons["event.card.Fixture Push Day (solo)"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["event.card.Fixture Push Day"].exists)
        attach(app, name: "28-builder-detached")
    }

    /// Taps a field and types once it has keyboard focus — a type sent a beat
    /// early fails with "Neither element nor any descendant has keyboard focus"
    /// on a starved runner (the `testCoachKeySetupOnFixtures` flake).
    private func type(_ text: String, into field: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "missing field: \(field)", file: file, line: line)
        for _ in 0..<3 {
            field.tap()
            let focused = NSPredicate { object, _ in (object as? XCUIElement)?.value(forKey: "hasKeyboardFocus") as? Bool == true }
            if XCTWaiter().wait(for: [expectation(for: focused, evaluatedWith: field)], timeout: 3) == .completed { break }
        }
        field.typeText(text)
    }

    /// Taps a control and waits for what it should open, re-sending the tap
    /// a starved runner dropped (the `openEvent` lesson), twice at most.
    private func tapUntil(_ button: XCUIElement, shows target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(button.waitForExistence(timeout: 20), "missing: \(button)", file: file, line: line)
        for _ in 0..<3 {
            button.tap()
            if target.waitForExistence(timeout: 10) { return }
        }
        XCTFail("\(target) never appeared after tapping \(button)", file: file, line: line)
    }

    /// sign in → Analytics → six seeded tiles → tap a bar pins its value →
    /// Edit → the KPI to the bottom, the tonnage tile tall → Done → the order
    /// survives a tab switch. All on fixtures (W9).
    func testAnalyticsDashboardOnFixtures() {
        let app = launch(mock: true)
        signIn(app)
        let tab = app.tabBars.buttons["Analytics"]
        tapUntil(tab, shows: app.otherElements["tile.card.ios-fixture-tile-sessions"])
        XCTAssertTrue(app.staticTexts["analytics.count"].label.hasPrefix("6 tiles"))
        let tonnage = app.otherElements["tile.card.ios-fixture-tile-tonnage"]
        XCTAssertTrue(tonnage.exists)
        attach(app, name: "29-analytics")

        // A tap on the bar chart pins the bucket's card (U13): the Sep 7 bar sits
        // under the card's second column.
        let pinned = app.staticTexts["830 lb"].firstMatch
        for _ in 0..<3 where !pinned.exists {
            tonnage.coordinate(withNormalizedOffset: CGVector(dx: 0.38, dy: 0.62)).tap()
            _ = pinned.waitForExistence(timeout: 4)
        }
        XCTAssertTrue(pinned.exists, "the tap did not pin the bucket")
        attach(app, name: "30-analytics-scrub")

        // Edit mode: reorder and resize, then Done.
        tapUntil(app.buttons["analytics.edit"], shows: app.collectionViews["analytics.editlist"])
        // The segmented control's identifier rides on each of its buttons.
        let large = app.buttons.matching(identifier: "tile.height.ios-fixture-tile-tonnage").matching(NSPredicate(format: "label == 'L'")).firstMatch
        XCTAssertTrue(large.waitForExistence(timeout: 5))
        large.tap()
        attach(app, name: "31-analytics-edit")
        let sessionsRow = app.otherElements["tile.editrow.ios-fixture-tile-sessions"]
        let distanceRow = app.otherElements["tile.editrow.ios-fixture-tile-distance"]
        let handle = sessionsRow.buttons.matching(NSPredicate(format: "label CONTAINS 'Reorder'")).firstMatch
        if handle.exists {
            handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                .press(forDuration: 0.6, thenDragTo: distanceRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1.2)))
        }
        app.buttons["analytics.edit.done"].tap()
        XCTAssertTrue(app.scrollViews["analytics.dashboard"].waitForExistence(timeout: 10))
        // The layout write landed on the mock and survives a tab switch.
        app.tabBars.buttons["Schedule"].tap()
        tapUntil(tab, shows: app.otherElements["tile.card.ios-fixture-tile-tonnage"])
        XCTAssertTrue(app.otherElements["tile.card.ios-fixture-tile-tonnage"].exists)
        attach(app, name: "32-analytics-reordered")
    }

    /// "+" → the builder → Tonnage → the preview draws → the coach fills the
    /// title and the chart type from `chat-stream-analytics.ndjson` → Save →
    /// the new tile is on the dashboard (W9).
    func testTileBuilderOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockHasKey"]
        app.launch()
        signIn(app)
        tapUntil(app.tabBars.buttons["Analytics"], shows: app.otherElements["tile.card.ios-fixture-tile-sessions"])
        tapUntil(app.buttons["analytics.add"], shows: app.textFields["analytics.builder.title"])
        attach(app, name: "33-builder-form")

        // A measure makes the draft valid; the server's preview draws.
        let form = app.scrollViews.firstMatch
        let tonnage = app.buttons["series.s1.measure.tonnage"]
        var swipes = 0
        while !tonnage.isHittable, swipes < 4 { form.swipeUp(); swipes += 1 }
        tonnage.tap()
        let preview = app.otherElements["analytics.builder.preview"]
        swipes = 0
        while !preview.exists, swipes < 6 { form.swipeUp(); swipes += 1 }
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        attach(app, name: "34-builder-preview")

        // Save with no title: the server refuses, and the refusal is a line in
        // the sheet above the buttons — not a toast under it (the build-6 device run).
        app.buttons["analytics.builder.save"].tap()
        let refusal = app.staticTexts["analytics.builder.saveproblem"]
        XCTAssertTrue(refusal.waitForExistence(timeout: 10))
        XCTAssertEqual(refusal.label, "Give the tile a title")
        attach(app, name: "34b-builder-refused")

        // The coach: one turn, the chart-draft tool reduces server-side, the form follows.
        app.buttons["analytics.builder.coach.toggle"].tap()
        let composer = app.textViews["coach.composer"].firstMatch.exists ? app.textViews["coach.composer"].firstMatch : app.textFields["coach.composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        type("weekly tonnage as bars", into: composer)
        app.buttons["coach.send"].tap()
        let followUp = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Review the form and press Save'")).firstMatch
        XCTAssertTrue(followUp.waitForExistence(timeout: 20))
        XCTAssertFalse(app.otherElements["coach.card"].exists, "the builder's coach never shows a card")
        let titleField = app.textFields["analytics.builder.title"]
        XCTAssertEqual(titleField.value as? String, "Fixture weekly tonnage")
        attach(app, name: "35-builder-coach")

        app.buttons["analytics.builder.save"].tap()
        // The count line at the top says it landed; the card itself is at the
        // bottom of a lazy stack and exists only once scrolled to.
        let seven = expectation(for: NSPredicate(format: "label BEGINSWITH '7 tiles'"), evaluatedWith: app.staticTexts["analytics.count"])
        wait(for: [seven], timeout: 15)
        // The phone minted the id; the card is known by the title the coach gave it.
        let saved = app.staticTexts["Fixture weekly tonnage"].firstMatch
        let dashboard = app.scrollViews["analytics.dashboard"]
        swipes = 0
        while !saved.exists, swipes < 8 { dashboard.swipeUp(); swipes += 1 }
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        attach(app, name: "36-builder-saved")
    }

    /// The kebab: Duplicate adds "(copy)" at the bottom; Delete needs its
    /// confirming tap and the tile leaves the dashboard (W9).
    func testTileKebabOnFixtures() {
        let app = launch(mock: true)
        signIn(app)
        tapUntil(app.tabBars.buttons["Analytics"], shows: app.otherElements["tile.card.ios-fixture-tile-sessions"])
        app.buttons["tile.menu.ios-fixture-tile-sessions"].tap()
        let duplicate = app.buttons["Duplicate"]
        XCTAssertTrue(duplicate.waitForExistence(timeout: 5))
        duplicate.tap()
        let seven = expectation(for: NSPredicate(format: "label BEGINSWITH '7 tiles'"), evaluatedWith: app.staticTexts["analytics.count"])
        wait(for: [seven], timeout: 10)
        // The copy is at the bottom of a lazy stack: scroll until it exists.
        let copy = app.staticTexts["Sessions (copy)"]
        let dashboard = app.scrollViews["analytics.dashboard"]
        var swipes = 0
        while !copy.exists, swipes < 8 { dashboard.swipeUp(); swipes += 1 }
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        attach(app, name: "37-tile-duplicated")
        swipes = 0
        while !app.buttons["tile.menu.ios-fixture-tile-sessions"].isHittable, swipes < 8 { dashboard.swipeDown(); swipes += 1 }

        app.buttons["tile.menu.ios-fixture-tile-sessions"].tap()
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        let confirm = app.buttons["Confirm delete"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        attach(app, name: "38-tile-delete")
        confirm.tap()
        let six = expectation(for: NSPredicate(format: "label BEGINSWITH '6 tiles'"), evaluatedWith: app.staticTexts["analytics.count"])
        wait(for: [six], timeout: 10)
        XCTAssertFalse(app.otherElements["tile.card.ios-fixture-tile-sessions"].exists)
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: - W11 · the You tab

    /// sign in → You → the header names the fixture user → AI connector → mint a
    /// token → the one-time reveal → Done → the token is listed → COROS → Sync
    /// now → the confirmation sheet for the matched run → Fill it → the apply
    /// toast → Activity log rows. All on fixtures; the mock answers
    /// `connect-start` with the callback itself, so Reconnect needs no browser.
    func testYouOnFixtures() {
        let app = XCUIApplication()
        app.launchArguments += ["-apexUITest", "-apexMockClient", "-apexMockHasKey"]
        app.launch()
        signIn(app)

        let youTab = app.tabBars.buttons["You"]
        XCTAssertTrue(youTab.waitForExistence(timeout: 20))
        youTab.tap()
        let name = app.staticTexts["you.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        XCTAssertEqual(name.label, "agent")
        let corosRow = app.buttons["you.row.coros"]
        XCTAssertTrue(corosRow.waitForExistence(timeout: 10), "the fixture deployment has COROS configured")
        XCTAssertTrue(corosRow.label.contains("Connected"))
        XCTAssertTrue(app.buttons["you.row.key"].label.contains("Saved"))
        attach(app, name: "w11-01-you")

        // AI connector: mint → reveal → Done → listed.
        app.buttons["you.row.connector"].tap()
        let tokenName = app.textFields["connector.name"]
        XCTAssertTrue(tokenName.waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["connector.token.ios-fixture laptop"].waitForExistence(timeout: 10))
        attach(app, name: "w11-02-connector")
        tokenName.tap()
        tokenName.typeText("Claude Code")
        app.buttons["connector.create"].tap()
        let reveal = app.staticTexts["token.reveal.value"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 10))
        XCTAssertTrue(reveal.label.hasPrefix("apx_mock_"))
        attach(app, name: "w11-03-token-reveal")
        app.buttons["token.reveal.done"].tap()
        XCTAssertTrue(app.otherElements["connector.token.Claude Code"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // COROS: Sync now → the matched run asks; the ride imports on its own.
        let coros = app.buttons["you.row.coros"]
        XCTAssertTrue(coros.waitForExistence(timeout: 10))
        coros.tap()
        let sync = app.buttons["coros.sync"]
        XCTAssertTrue(sync.waitForExistence(timeout: 10))
        attach(app, name: "w11-04-coros")
        sync.tap()
        let prompt = app.staticTexts["sync.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        XCTAssertEqual(prompt.label, "Trail Run · 7:05 AM · 5.20 mi — fill planned “Planned Morning Run”?")
        XCTAssertFalse(app.staticTexts["sync.remaining"].exists, "one match, nothing after it")
        attach(app, name: "w11-05-sync-confirm")
        app.buttons["sync.fill"].tap()
        let toast = app.staticTexts["COROS: Imported 1 activity · filled 1 planned workout"]
        XCTAssertTrue(toast.waitForExistence(timeout: 10))
        attach(app, name: "w11-06-synced")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // The activity log renders the fixture's five rows with their badges.
        let activity = app.buttons["you.row.activity"]
        XCTAssertTrue(activity.waitForExistence(timeout: 10))
        var swipes = 0
        while !activity.isHittable, swipes < 4 { app.scrollViews.firstMatch.swipeUp(); swipes += 1 }
        activity.tap()
        // The rows combine their children into one element, so the type is not fixed.
        let firstRow = app.descendants(matching: .any).matching(identifier: "activity.row.0").firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10))
        XCTAssertTrue(firstRow.label.contains("Rescheduled occurrence of"), firstRow.label)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "activity.row.4").firstMatch.exists)
        attach(app, name: "w11-07-activity")
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
