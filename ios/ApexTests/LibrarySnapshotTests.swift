import ApexCore
import ApexFeatures
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/LibrarySnapshotTests test
final class LibrarySnapshotTests: XCTestCase {
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
    private func loaded() async -> LibraryModel {
        let fixtures = libraryFixtures()
        let hooks = LibraryHooks(definitions: fixtures.definitions, templates: fixtures.templates)
        let model = makeLibraryModel(.library(), hooks: hooks)
        await model.start()
        return model
    }

    @MainActor
    private func history() -> LibraryModel.HistoryOutcome {
        let data = YouTransport.fixture("query-get_exercise_history.json")
        let envelope = try! JSONDecoder().decode(QueryEnvelope<ExerciseHistoryResult>.self, from: data)
        return .history(envelope.result)
    }

    /// The list: the decorated fixture row, an undecorated one, the archived divider.
    @MainActor
    func testList() async {
        let model = await loaded()
        snapshot(NavigationStack { LibraryHomeView(model: model) }, named: "list")
        snapshot(NavigationStack { LibraryHomeView(model: model) }.environment(\.sizeCategory, .extraExtraLarge), named: "list-xxl")
        snapshot(
            NavigationStack { LibraryHomeView(model: model) }.environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge),
            named: "list-axxxl"
        )
        model.query = "nothing"
        snapshot(NavigationStack { LibraryHomeView(model: model) }, named: "list-empty", size: CGSize(width: 393, height: 420))
    }

    /// The detail with its history: tags, the PR and session cards, the trend, the sessions.
    @MainActor
    func testDetail() async {
        let model = await loaded()
        snapshot(NavigationStack { ExerciseDetailView(model: model, id: "ios-fixture-def", history: history()) }, named: "detail")
        snapshot(NavigationStack { ExerciseDetailView(model: model, id: "ios-fixture-def", history: history()) }, named: "detail-16e", size: CGSize(width: 390, height: 844))
        snapshot(NavigationStack { ExerciseDetailView(model: model, id: "cable-row", history: .none) }, named: "detail-nohistory", size: CGSize(width: 393, height: 420))
        snapshot(
            NavigationStack { ExerciseDetailView(model: model, id: "ios-fixture-def", history: history()) }
                .environment(\.sizeCategory, .accessibilityExtraExtraExtraLarge),
            named: "detail-axxxl", size: CGSize(width: 393, height: 1100)
        )
    }

    /// The editor sheet, and the rename hint under a changed name.
    @MainActor
    func testEditor() async {
        let model = await loaded()
        let press = model.definition(id: "ios-fixture-def")!
        snapshot(DefinitionEditorSheet(model: model, definition: press) {}, named: "editor")
    }

    @MainActor
    func testWorkoutLibrary() async {
        let model = await loaded()
        snapshot(NavigationStack { LibraryHomeView(model: model, tab: .workouts) }, named: "workout-library", size: CGSize(width: 393, height: 520))
    }
}
