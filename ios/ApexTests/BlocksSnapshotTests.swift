import ApexCore
import ApexFeatures
import ApexUI
import SnapshotTesting
import SwiftUI
import XCTest

/// Opt-in, not a CI gate (see ScheduleSnapshotTests for why):
///
///   TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild ... -only-testing:ApexTests/BlocksSnapshotTests test
final class BlocksSnapshotTests: XCTestCase {
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
    private func loaded(withProgress: Bool = false) async -> BlocksModel {
        let transport = YouTransport.blocks()
        let model = makeBlocksModel(transport)
        await model.start()
        if withProgress {
            transport.answerDetail()
            await model.loadProgress(id: "ios-fixture-block-base")
        }
        return model
    }

    /// The list: the active block with its week, the past one, the objective.
    @MainActor
    func testList() async {
        let model = await loaded()
        snapshot(NavigationStack { BlocksView(model: model) }, named: "list")
        snapshot(NavigationStack { BlocksView(model: model) }.environment(\.sizeCategory, .extraExtraLarge), named: "list-xxl")
        let empty = makeBlocksModel({ let t = YouTransport(); t.set("POST /api/query get_training_blocks", .json(200, Data(#"{"tool":"get_training_blocks","result":{"today":"2026-09-08","current":null,"blocks":[],"objectives":[]}}"#.utf8))); return t }())
        await empty.start()
        snapshot(NavigationStack { BlocksView(model: empty) }, named: "list-empty", size: CGSize(width: 393, height: 520))
    }

    /// The detail with progress: to date, this week, the by-week table with
    /// its attainment column (U12), the PR set inside the block.
    @MainActor
    func testDetail() async {
        let model = await loaded(withProgress: true)
        snapshot(NavigationStack { BlockDetailView(model: model, id: "ios-fixture-block-base") }, named: "detail", size: CGSize(width: 393, height: 1400))
        snapshot(NavigationStack { BlockDetailView(model: model, id: "ios-fixture-block-base") }.environment(\.sizeCategory, .extraExtraLarge), named: "detail-xxl", size: CGSize(width: 393, height: 1600))
    }

    @MainActor
    func testEditor() async {
        let model = await loaded()
        snapshot(BlockEditorSheet(model: model, block: nil) {}, named: "editor-new")
        snapshot(BlockEditorSheet(model: model, block: model.block(id: "ios-fixture-block-base")) {}, named: "editor-edit")
    }

    /// The cycle sheet with the server's preview drawn, and with a conflict.
    @MainActor
    func testCycle() async {
        let model = await loaded()
        model.scheduleCyclePreview(CycleSpec(startDate: "2027-01-06", cycles: 2, namePrefix: "Fixture Cycle"))
        _ = await waitFor { if case .ready = model.preview { return true } else { return false } }
        snapshot(CycleEditorSheet(model: model) {}, named: "cycle", size: CGSize(width: 393, height: 1300))

        let conflicted = makeBlocksModel({ let t = YouTransport.blocks(); t.set("POST /api/blocks?resource=cycle", .json(200, YouTransport.fixture("blocks-cycle-conflict.json"))); return t }())
        await conflicted.start()
        conflicted.scheduleCyclePreview(CycleSpec(startDate: "2026-08-31", cycles: 2, namePrefix: "Fixture Cycle"))
        _ = await waitFor { if case .ready = conflicted.preview { return true } else { return false } }
        snapshot(CycleEditorSheet(model: conflicted) {}, named: "cycle-conflict", size: CGSize(width: 393, height: 1300))
    }
}
