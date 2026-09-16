import ApexCore
import ApexFeatures
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/MealsSnapshotTests test
final class MealsSnapshotTests: XCTestCase {
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
    private func loaded() async -> MealsModel {
        let model = makeMealsModel(.meals(), hooks: MealsHooks())
        await model.start()
        return model
    }

    /// The day list on the fixture day: the roll-up and both meals.
    @MainActor
    func testDayList() async {
        let model = await loaded()
        snapshot(NavigationStack { MealsDayListView(model: model) }, named: "day-list", size: CGSize(width: 393, height: 520))
        model.select(DayKey("2026-09-09")!)
        snapshot(NavigationStack { MealsDayListView(model: model) }, named: "day-list-empty", size: CGSize(width: 393, height: 420))
    }

    /// The composer new (favorites chips, the derived-kcal placeholder) and
    /// editing the fixture bowl (its stored split reopened).
    @MainActor
    func testComposer() async {
        let model = await loaded()
        let day = DayKey("2026-09-08")!
        snapshot(MealComposerSheet(model: model, route: .create(day)) {}, named: "composer-new", size: CGSize(width: 393, height: 1100))
        let bowl = model.item(id: "ios-fixture-meal-2", on: day)!
        snapshot(MealComposerSheet(model: model, route: .edit(day: day, item: bowl)) {}, named: "composer-edit", size: CGSize(width: 393, height: 1100))
        snapshot(MealComposerSheet(model: model, route: .edit(day: day, item: bowl)) {}.environment(\.sizeCategory, .extraExtraLarge), named: "composer-xxl", size: CGSize(width: 393, height: 1400))
    }
}
