import ApexCore
import ApexFeatures
import XCTest

/// The Blocks model (W10): the list read, a block's progress by id, the
/// editor's writes, the inline objective, the cycle preview and its commit.
final class BlocksModelTests: XCTestCase {
    @MainActor
    private func started(_ transport: YouTransport = .blocks(), cache: any CacheStore = MemoryCacheStore()) async -> BlocksModel {
        let model = makeBlocksModel(transport, cache: cache)
        await model.start()
        return model
    }

    @MainActor
    func testStartReadsTheListWithTodayAndObjectivesAndCachesIt() async {
        let transport = YouTransport.blocks()
        let cache = MemoryCacheStore()
        let model = await started(transport, cache: cache)
        XCTAssertTrue(model.hasLoaded)
        XCTAssertEqual(model.blocks.map(\.id), ["ios-fixture-block-spring", "ios-fixture-block-base"])
        XCTAssertEqual(model.current?.id, "ios-fixture-block-base")
        XCTAssertEqual(model.objectives.map(\.name), ["Fixture Spring Objective"])
        XCTAssertEqual(model.objective(for: model.blocks[1])?.id, "ios-fixture-objective-1")

        let args = transport.queries(tool: "get_training_blocks").first?.body?["args"] as? [String: Any]
        XCTAssertEqual(args?["scope"] as? String, "all")
        XCTAssertEqual(args?["include_progress"] as? Bool, false)
        XCTAssertEqual(args?["include_objectives"] as? Bool, true)
        XCTAssertEqual(args?["today"] as? String, "2026-09-08", "the caller's day, never the server's clock")

        // The next cold open renders from the cache before the network.
        let offline = makeBlocksModel(YouTransport(), cache: cache)
        await offline.start()
        XCTAssertEqual(offline.blocks.count, 2)
        XCTAssertNil(offline.loadError, "a cached list is not an outage")
    }

    @MainActor
    func testAnOutageWithNothingCachedIsALoadError() async {
        let model = await started(YouTransport())
        XCTAssertFalse(model.hasLoaded)
        XCTAssertEqual(model.loadError, "You're offline — try again when connected.")
    }

    @MainActor
    func testProgressIsReadByBlockIdForTodayAndCachedForTheSameDay() async {
        let transport = YouTransport.blocks()
        let cache = MemoryCacheStore()
        let model = await started(transport, cache: cache)
        transport.answerDetail()
        await model.loadProgress(id: "ios-fixture-block-base")
        let progress = model.progress["ios-fixture-block-base"]
        XCTAssertEqual(progress?.weeksElapsed, 1)
        XCTAssertEqual(progress?.currentWeek, 2)
        XCTAssertEqual(progress?.prs.first?.exerciseName, "Fixture Press")
        let args = transport.queries(tool: "get_training_blocks").last?.body?["args"] as? [String: Any]
        XCTAssertEqual(args?["block_id"] as? String, "ios-fixture-block-base")
        XCTAssertEqual(args?["today"] as? String, "2026-09-08")

        // Offline, the cached progress for the same day still renders.
        let offline = makeBlocksModel(YouTransport(), cache: cache)
        await offline.start()
        await offline.loadProgress(id: "ios-fixture-block-base")
        XCTAssertEqual(offline.progress["ios-fixture-block-base"]?.weeksTotal, 4)
        XCTAssertFalse(offline.progressFailed.contains("ios-fixture-block-base"))

        // With nothing cached, a failure is reported for the screen to say so.
        await offline.loadProgress(id: "ios-fixture-block-spring")
        XCTAssertTrue(offline.progressFailed.contains("ios-fixture-block-spring"))
    }

    @MainActor
    func testCreateSendsTheRowWithAttributionAndRefreshesTheList() async {
        let transport = YouTransport.blocks()
        let model = await started(transport)
        var form = BlockForm.new(today: model.today)
        form.name = "Autumn base"
        form.cardioMinutes = "240"
        let refusal = await model.createBlock(form)
        XCTAssertNil(refusal)
        let post = transport.requests("/api/blocks").last { $0.method == "POST" }
        XCTAssertEqual(post?.body?["name"] as? String, "Autumn base")
        XCTAssertEqual(post?.body?["start_date"] as? String, "2026-09-07")
        XCTAssertEqual(post?.body?["end_date_exclusive"] as? String, "2026-10-05")
        XCTAssertEqual(post?.body?["triggered_by"] as? String, "user")
        XCTAssertEqual((post?.body?["log"] as? [String: Any])?["resource_name"] as? String, "Autumn base")
        XCTAssertEqual(transport.queries(tool: "get_training_blocks").count, 2, "the list is re-read after a write")
        XCTAssertEqual(model.pendingNotice, "Block created")
    }

    @MainActor
    func testUpdateAndDeleteCarryTheLogAndAnOverlapIsTheServersText() async {
        let transport = YouTransport.blocks()
        let model = await started(transport)
        let base = model.block(id: "ios-fixture-block-base")!
        var form = BlockForm(block: base)
        form.phase = nil
        let updated = await model.updateBlock(base, form)
        XCTAssertNil(updated)
        let patch = transport.requests("/api/blocks").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.query, "id=ios-fixture-block-base")
        let fields = patch?.body?["fields"] as? [String: Any]
        XCTAssertTrue(fields?["phase"] is NSNull, "a cleared phase is an explicit null")
        XCTAssertEqual(fields?["objective_id"] as? String, "ios-fixture-objective-1")
        XCTAssertEqual((patch?.body?["log"] as? [String: Any])?["resource_name"] as? String, "Fixture Base Block")

        transport.set("PATCH /api/blocks", status: 409, body: "That date range overlaps an existing block")
        let overlap = await model.updateBlock(base, form)
        XCTAssertEqual(overlap, "That date range overlaps an existing block")

        let deleted = await model.deleteBlock(base)
        XCTAssertNil(deleted)
        let delete = transport.requests("/api/blocks").last { $0.method == "DELETE" }
        XCTAssertEqual(delete?.query, "id=ios-fixture-block-base")
        XCTAssertEqual((delete?.body?["log"] as? [String: Any])?["triggered_by"] as? String, "user")
        XCTAssertEqual(model.pendingNotice, "Block deleted")
    }

    @MainActor
    func testTheInlineObjectiveIsCreatedWithTheWebsFixedColumns() async {
        let transport = YouTransport.blocks()
        let model = await started(transport)
        let outcome = await model.createObjective(name: " Rainier ", targetDate: DayKey("2027-07-01"), discipline: "alpine")
        guard case .created(let objective) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(objective.id, "obj-new")
        XCTAssertEqual(objective.name, "Rainier")
        let post = transport.requests("/api/objectives").last
        XCTAssertEqual(post?.body?["notes"] as? String, "")
        XCTAssertEqual(post?.body?["status"] as? String, "active")
        XCTAssertEqual((post?.body?["required_capabilities"] as? [Any])?.count, 0)
        XCTAssertEqual(post?.body?["target_date"] as? String, "2027-07-01")

        let blank = await model.createObjective(name: "  ", targetDate: nil, discipline: nil)
        XCTAssertEqual(blank, .problem("Give the objective a name"))
    }

    @MainActor
    func testTheCyclePreviewIsTheServersAndCommitSendsItsRowsBack() async {
        let transport = YouTransport.blocks()
        let model = await started(transport)
        let spec = CycleSpec(startDate: "2027-01-06", cycles: 2, namePrefix: "Fixture Cycle")
        model.scheduleCyclePreview(spec)
        let ready = await waitFor { if case .ready = model.preview { return true } else { return false } }
        XCTAssertTrue(ready)
        guard case .ready(let response) = model.preview else { return XCTFail("\(model.preview)") }
        XCTAssertEqual(response.blocks?.count, 4)
        XCTAssertNil(response.conflict)
        let posted = transport.requests("/api/blocks").last { $0.query == "resource=cycle" }
        XCTAssertEqual((posted?.body?["spec"] as? [String: Any])?["namePrefix"] as? String, "Fixture Cycle")

        let committed = await model.commitCycle(response)
        XCTAssertNil(committed)
        let commit = transport.requests("/api/blocks").last { $0.query == "batch=1" }
        XCTAssertEqual((commit?.body?["rows"] as? [Any])?.count, 4)
        XCTAssertEqual(((commit?.body?["rows"] as? [[String: Any]])?.first)?["name"] as? String, "Fixture Cycle · Build 1")
        XCTAssertEqual((commit?.body?["log"] as? [String: Any])?["resource_name"] as? String, "Fixture Cycle · Build 1")
        XCTAssertEqual(model.pendingNotice, "Added 4 blocks — 8 weeks")
    }

    @MainActor
    func testARefusedSpecAndAnOutageReadDifferently() async {
        let transport = YouTransport.blocks()
        let model = await started(transport)
        transport.set("POST /api/blocks?resource=cycle", .json(200, YouTransport.fixture("blocks-cycle-problem.json")))
        model.scheduleCyclePreview(CycleSpec(startDate: "2027-01-04", namePrefix: ""))
        _ = await waitFor { model.preview != .loading && model.preview != .idle }
        XCTAssertEqual(model.preview, .problem("A cycle needs a name"))

        transport.set("POST /api/blocks?resource=cycle", .fail)
        model.scheduleCyclePreview(CycleSpec(startDate: "2027-01-04", namePrefix: "x"))
        _ = await waitFor { if case .failed = model.preview { return true } else { return false } }
        XCTAssertEqual(model.preview, .failed("You're offline — try again when connected."))

        model.resetPreview()
        XCTAssertEqual(model.preview, .idle)
    }

    @MainActor
    func testLabels() {
        let base = BlockSummary(id: "b", name: "Base", startDate: "2026-08-31", endDateExclusive: "2026-09-28", weeks: 4, currentWeek: 2)
        XCTAssertEqual(BlocksModel.weekLabel(base), "week 2 of 4")
        XCTAssertEqual(BlocksModel.weekLabel(BlockSummary(id: "p", name: "Past", startDate: "2026-03-02", endDateExclusive: "2026-03-09", weeks: 1)), "1 week")
        XCTAssertEqual(BlocksModel.periodLabel(startDate: "2026-08-31", endDateExclusive: "2026-09-28"), "Aug 31 – Sep 27")
        XCTAssertEqual(BlocksModel.periodLabelWithYear(startDate: "2027-01-04", endDateExclusive: "2027-03-01"), "Jan 4 – Feb 28, 2027")
    }
}
