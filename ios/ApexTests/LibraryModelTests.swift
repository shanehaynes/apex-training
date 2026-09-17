import ApexCore
import ApexFeatures
import XCTest

/// The Library model (W10): the cached lists decorated by `search_exercises`,
/// the filter, the editor's writes, the history read, the template archive.
final class LibraryModelTests: XCTestCase {
    @MainActor
    private func started(_ transport: YouTransport = .library(), cache: any CacheStore = MemoryCacheStore()) async -> (LibraryModel, LibraryHooks) {
        let fixtures = libraryFixtures()
        let hooks = LibraryHooks(definitions: fixtures.definitions, templates: fixtures.templates)
        let model = makeLibraryModel(transport, hooks: hooks, cache: cache)
        await model.start()
        return (model, hooks)
    }

    @MainActor
    func testStartReadsTheListsAndDecoratesRowsFromOneStatsCall() async {
        let transport = YouTransport.library()
        let cache = MemoryCacheStore()
        let (model, _) = await started(transport, cache: cache)
        XCTAssertEqual(model.definitions.count, 3)
        XCTAssertEqual(model.templates.map(\.id), ["ios-fixture-template"])

        let press = model.definition(id: "ios-fixture-def")!
        XCTAssertEqual(model.lastPerformedLabel(press), "Last: Sep 22")
        XCTAssertEqual(model.referencesLabel(press), "in 1 workout")
        XCTAssertEqual(model.referenceCount(press), 1)
        // A definition the stats call did not return shows nothing, not "unused".
        XCTAssertNil(model.lastPerformedLabel(model.definition(id: "cable-row")!))
        XCTAssertFalse(model.statsUnavailable)

        let calls = transport.queries(tool: "search_exercises")
        XCTAssertEqual(calls.count, 1, "one call decorates the whole library")
        let args = calls[0].body?["args"] as? [String: Any]
        XCTAssertEqual(args?["include_archived"] as? Bool, true)
        XCTAssertEqual(args?["include_references"] as? Bool, true)
        XCTAssertEqual(args?["limit"] as? Int, 500)
        // And the answer is cached for the next cold open.
        let cached = try? await cache.read(kind: .libraryStats, key: ScheduleCacheKey.libraryStats)
        XCTAssertNotNil(cached)
    }

    @MainActor
    func testACachedStatsAnswerDecoratesRowsBeforeTheNetwork() async {
        let cache = MemoryCacheStore()
        let (_, _) = await started(.library(), cache: cache)
        // A second model over the same cache and a dead network still decorates.
        let dead = YouTransport()
        let fixtures = libraryFixtures()
        let hooks = LibraryHooks(definitions: fixtures.definitions, templates: fixtures.templates)
        let model = makeLibraryModel(dead, hooks: hooks, cache: cache)
        await model.start()
        XCTAssertEqual(model.lastPerformedLabel(model.definition(id: "ios-fixture-def")!), "Last: Sep 22")
        XCTAssertFalse(model.statsUnavailable, "a cached answer is not an outage")
    }

    @MainActor
    func testAStatsOutageLeavesRowsUndecoratedWithoutAToast() async {
        let (model, _) = await started(YouTransport())
        XCTAssertEqual(model.definitions.count, 3, "the lists are the cache's, not the network's")
        XCTAssertTrue(model.statsUnavailable)
        XCTAssertNil(model.referencesLabel(model.definition(id: "ios-fixture-def")!))
    }

    @MainActor
    func testTheFilterMatchesNameAliasesAndMuscleGroupsWithinTheCategory() async {
        let (model, _) = await started()
        XCTAssertEqual(model.active.map(\.id), ["cable-row", "ios-fixture-def"], "sorted by name")
        XCTAssertEqual(model.archived.map(\.id), ["old-jog"])

        model.query = "seated"
        XCTAssertEqual(model.active.map(\.id), ["cable-row"], "an alias matches")
        model.query = "CHEST"
        XCTAssertEqual(model.active.map(\.id), ["ios-fixture-def"], "a muscle group matches, case-insensitively")
        model.query = ""
        model.category = "cardio"
        XCTAssertEqual(model.active, [])
        XCTAssertEqual(model.archived.map(\.id), ["old-jog"])
        model.category = "all"
        model.query = "nothing here"
        XCTAssertTrue(model.active.isEmpty && model.archived.isEmpty)
    }

    @MainActor
    func testSaveSendsOnlyTheChangedColumnsAndRefreshesTheSchedule() async {
        let transport = YouTransport.library()
        let (model, hooks) = await started(transport)
        let press = model.definition(id: "ios-fixture-def")!
        var form = DefinitionForm(definition: press)
        form.name = "Fixture Bench"
        form.defaultSets = "4"
        let refusal = await model.save(press, form: form)
        XCTAssertNil(refusal)

        let patch = transport.requests("/api/exercise-definitions").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.query, "id=ios-fixture-def")
        let fields = patch?.body?["fields"] as? [String: Any]
        XCTAssertEqual(fields?.keys.sorted(), ["canonical_name", "default_sets"])
        XCTAssertEqual(fields?["canonical_name"] as? String, "Fixture Bench")
        XCTAssertEqual(fields?["default_sets"] as? Int, 4)
        let log = patch?.body?["log"] as? [String: Any]
        XCTAssertEqual(log?["definition_name"] as? String, "Fixture Press", "the log names the definition as it was")
        XCTAssertEqual(log?["triggered_by"] as? String, "user")
        XCTAssertEqual(hooks.refreshes, 1)
        XCTAssertEqual(transport.queries(tool: "search_exercises").count, 2, "the stats are re-read after a write")
        XCTAssertEqual(model.pendingNotice, "Updated “Fixture Bench”")
        model.flushNotice()
        XCTAssertNil(model.pendingNotice)
    }

    @MainActor
    func testAnUnchangedFormSavesNothing() async {
        let transport = YouTransport.library()
        let (model, hooks) = await started(transport)
        let press = model.definition(id: "ios-fixture-def")!
        let refusal = await model.save(press, form: DefinitionForm(definition: press))
        XCTAssertNil(refusal)
        XCTAssertTrue(transport.requests("/api/exercise-definitions").isEmpty)
        XCTAssertEqual(hooks.refreshes, 0)
        XCTAssertNil(model.pendingNotice)
    }

    @MainActor
    func testArchiveSendsATimestampAndRestoreAnExplicitNull() async {
        let transport = YouTransport.library()
        let (model, _) = await started(transport)
        let press = model.definition(id: "ios-fixture-def")!
        let archived = await model.setArchived(press, true)
        XCTAssertNil(archived)
        var fields = (transport.requests("/api/exercise-definitions").last?.body?["fields"] as? [String: Any])
        XCTAssertEqual(fields?["archived_at"] as? String, "2026-09-08T12:00:00.000Z")
        XCTAssertEqual(model.pendingNotice, "Archived — existing workouts keep it")

        let restored = await model.setArchived(press, false)
        XCTAssertNil(restored)
        fields = transport.requests("/api/exercise-definitions").last?.body?["fields"] as? [String: Any]
        XCTAssertTrue(fields?["archived_at"] is NSNull, "restore clears the column")
        XCTAssertEqual(model.pendingNotice, "Restored to the library")
    }

    @MainActor
    func testARefusalComesBackAsTheServersTextWithNoNotice() async {
        let transport = YouTransport.library()
        transport.set("PATCH /api/exercise-definitions", status: 400, body: "Unknown definition fields: colour")
        let (model, hooks) = await started(transport)
        let press = model.definition(id: "ios-fixture-def")!
        var form = DefinitionForm(definition: press)
        form.name = "Bench"
        let refusal = await model.save(press, form: form)
        XCTAssertEqual(refusal, "Unknown definition fields: colour")
        XCTAssertNil(model.pendingNotice)
        XCTAssertEqual(hooks.refreshes, 0)

        transport.set("PATCH /api/exercise-definitions", .fail)
        let offline = await model.save(press, form: form)
        XCTAssertEqual(offline, "You're offline — try again when connected.")
    }

    @MainActor
    func testHistoryIsReadByTheCanonicalNameMemoisedAndA400MeansNone() async {
        let transport = YouTransport.library()
        let (model, _) = await started(transport)
        let press = model.definition(id: "ios-fixture-def")!
        let first = await model.history(for: press)
        guard case .history(let stats) = first else { return XCTFail("\(first)") }
        XCTAssertEqual(stats.canonicalName, "Fixture Press")
        XCTAssertEqual(stats.allTimeBest?.display, "132")
        let args = transport.queries(tool: "get_exercise_history").first?.body?["args"] as? [String: Any]
        XCTAssertEqual(args?["exercise_name"] as? String, "Fixture Press")

        _ = await model.history(for: press)
        XCTAssertEqual(transport.queries(tool: "get_exercise_history").count, 1, "memoised for the session")
        XCTAssertFalse(model.needsHistoryReload(for: press))

        transport.set("POST /api/query get_exercise_history", status: 400, body: "No logged history for \"Cable Row\".")
        let row = model.definition(id: "cable-row")!
        XCTAssertTrue(model.needsHistoryReload(for: row))
        let none = await model.history(for: row)
        XCTAssertEqual(none, .none)

        transport.set("POST /api/query get_exercise_history", .fail)
        let jog = model.definition(id: "old-jog")!
        let failed = await model.history(for: jog)
        XCTAssertEqual(failed, .failed("You're offline — try again when connected."))
    }

    @MainActor
    func testTemplateArchiveDelegatesToTheScheduleAndRereadsTheList() async {
        let (model, hooks) = await started()
        XCTAssertEqual(model.activeTemplates.map(\.id), ["ios-fixture-template"])
        XCTAssertEqual(LibraryModel.templateMeta(model.templates[0]), "1 exercise · 45m")
        await model.archiveTemplate(model.templates[0], archived: true)
        XCTAssertEqual(hooks.archived.map(\.id), ["ios-fixture-template"])
        XCTAssertEqual(hooks.archived.map(\.archived), [true])
        XCTAssertTrue(model.activeTemplates.isEmpty)
        XCTAssertEqual(model.archivedTemplates.map(\.id), ["ios-fixture-template"])
    }

    @MainActor
    func testDateLabels() {
        XCTAssertEqual(LibraryModel.shortDate(DayKey("2026-09-22")!), "Sep 22")
        XCTAssertEqual(LibraryModel.sessionDate(DayKey("2026-09-22")!), "Tue Sep 22, 2026")
        XCTAssertEqual(LibraryModel.referencesText(0), "unused")
        XCTAssertEqual(LibraryModel.referencesText(1), "in 1 workout")
        XCTAssertEqual(LibraryModel.referencesText(3), "in 3 workouts")
    }
}
