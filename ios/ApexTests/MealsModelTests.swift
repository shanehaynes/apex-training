import ApexCore
import ApexUI
import ApexFeatures
import XCTest

/// The Meals model (W10): the month read and the favorites, the composer's
/// writes and their refusals, the favorites library, the labels.
final class MealsModelTests: XCTestCase {
    private let fixtureDay = DayKey("2026-09-08")!

    @MainActor
    private func started(_ transport: YouTransport = .meals(), cache: any CacheStore = MemoryCacheStore()) async -> (MealsModel, MealsHooks) {
        let hooks = MealsHooks()
        let model = makeMealsModel(transport, hooks: hooks, cache: cache)
        await model.start()
        return (model, hooks)
    }

    @MainActor
    func testStartReadsTheFavoritesAndTheMonthAroundToday() async {
        let transport = YouTransport.meals()
        let (model, _) = await started(transport)
        XCTAssertEqual(model.selectedDay, fixtureDay)
        XCTAssertEqual(model.favorites.map(\.title), ["Fixture Overnight Oats"])
        XCTAssertTrue(model.favoritesLoaded)
        let day = model.meals(on: fixtureDay)
        XCTAssertEqual(day?.mealCount, 2)
        XCTAssertEqual(MealsModel.rollup(day), "1114 kcal · P 70 / C 138 / F 30")
        XCTAssertEqual(MealsModel.rollup(nil), "No meals logged")
        let args = transport.queries(tool: "get_meals").first?.body?["args"] as? [String: Any]
        XCTAssertEqual(args?["start_date"] as? String, "2026-09-01")
        XCTAssertEqual(args?["end_date"] as? String, "2026-09-30")
        XCTAssertEqual(args?["include_items"] as? Bool, true)

        let item = model.item(id: "ios-fixture-meal-2", on: fixtureDay)
        XCTAssertEqual(item?.title, "Fixture Chicken Bowl")
        XCTAssertEqual(MealsModel.summary(item!), "594 kcal · P 48 / C 60 / F 18")
    }

    @MainActor
    func testCreateSendsTheFlatRowWithAttributionThenReloadsTheMonthAndTellsTheSchedule() async {
        let transport = YouTransport.meals()
        let (model, hooks) = await started(transport)
        var form = MealForm(day: fixtureDay)
        form.title = "Toast"
        form.protein = "12"
        form.timeMinutes = 8 * 60
        form.mealType = "breakfast"
        let refusal = await model.save(form, editing: nil, originalDay: nil)
        XCTAssertNil(refusal)
        let post = transport.requests("/api/meals").last { $0.method == "POST" }
        XCTAssertTrue((post?.body?["id"] as? String ?? "").hasPrefix("meal-"))
        XCTAssertEqual(post?.body?["title"] as? String, "Toast")
        XCTAssertEqual(post?.body?["date"] as? String, "2026-09-08")
        XCTAssertEqual(post?.body?["time"] as? String, "8:00 AM")
        XCTAssertEqual(post?.body?["meal_type"] as? String, "breakfast")
        XCTAssertEqual(post?.body?["protein_g"] as? Int, 12)
        XCTAssertTrue(post?.body?["carbs_g"] is NSNull)
        XCTAssertEqual(post?.body?["triggered_by"] as? String, "user")
        XCTAssertEqual(transport.queries(tool: "get_meals").count, 2, "the month is re-read")
        XCTAssertEqual(hooks.changes, 1)
        XCTAssertEqual(model.pendingNotice, "Meal added")
        model.flushNotice()
        XCTAssertNil(model.pendingNotice)
    }

    /// A backoff that never ends on its own: the outbox lane never gives up
    /// on the network, and under `TestClock` it would retry in a hot loop for
    /// as long as the test keeps it offline.
    private struct StalledClock: ApexClock {
        let now: Date
        func sleep(seconds: Double) async throws { try await Task.sleep(for: .seconds(3600)) }
    }

    @MainActor
    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
    }

    @MainActor
    func testACreateWithTheQueueWaitsInTheOutboxAndIsListedOnceItLands() async throws {
        let transport = YouTransport.mealsOffline()
        let store = MemoryWriteQueueStore()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
        let queue = WriteQueue(store: store, client: client, clock: StalledClock(now: coachTestNow))
        let hooks = MealsHooks()
        let model = makeMealsModel(transport, hooks: hooks, writeQueue: queue)
        await model.start()

        var form = MealForm(day: fixtureDay)
        form.title = "Toast"
        form.protein = "12"
        let refusal = await model.save(form, editing: nil, originalDay: nil)
        XCTAssertNil(refusal, "no signal is not a refusal")
        XCTAssertEqual(model.pendingNotice, MealsModel.queuedNotice, "queued, not \"added\": the meal is listed once it lands")
        XCTAssertEqual(model.pendingNoticeLevel, .info)
        await queue.flush(.outbox)
        XCTAssertEqual(model.pendingMeals["2026-09-08"], 1, "waiting on its day")
        let queued = await store.all.map(\.payload.action)
        XCTAssertEqual(queued, [.meal])
        let tried = transport.requests("/api/meals").filter { $0.method == "POST" }
        XCTAssertEqual(tried.count, 1, "one try, then the lane waits for the network")
        XCTAssertEqual(transport.queries(tool: "get_meals").count, 1, "nothing to re-read: the server has no meal yet")
        XCTAssertEqual(hooks.changes, 0)

        // The connection is back: it lands with the id minted at save time,
        // the month is re-read and the schedule told, as a direct save does.
        transport.set("POST /api/meals", .json(200, Data(#"{"id":"meal-new"}"#.utf8)))
        await queue.resume()
        await queue.awaitRetries()
        try await waitUntil { model.pendingMeals.isEmpty && hooks.changes == 1 }
        XCTAssertEqual(model.pendingMeals, [:])
        let landed = transport.requests("/api/meals").filter { $0.method == "POST" }
        XCTAssertEqual(landed.count, 2)
        XCTAssertEqual(landed[0].body?["id"] as? String, landed[1].body?["id"] as? String, "the same meal both times")
        XCTAssertEqual(landed[1].body?["title"] as? String, "Toast")
        XCTAssertEqual(landed[1].body?["triggered_by"] as? String, "user")
        XCTAssertEqual(transport.queries(tool: "get_meals").count, 2, "the month is re-read once it lands")
        XCTAssertEqual(hooks.changes, 1)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        model.stop()
    }

    @MainActor
    private func queued(_ transport: YouTransport, policy: RetryPolicy = .default) async -> (MealsModel, WriteQueue, MemoryWriteQueueStore, MealsHooks) {
        let store = MemoryWriteQueueStore()
        let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
        let queue = WriteQueue(store: store, client: client, clock: StalledClock(now: coachTestNow), policy: policy)
        let hooks = MealsHooks()
        let model = makeMealsModel(transport, hooks: hooks, writeQueue: queue)
        await model.start()
        return (model, queue, store, hooks)
    }

    @MainActor
    func testAQueuedCreateTheServerRefusesIsKeptWithItsContentUntilFixedOrLetGo() async throws {
        // The fat split is the server's rule (the form does not check it):
        // queued, the refusal comes after the sheet closed. The meal is kept
        // whole for Fix, said once, and never built into the list.
        let transport = YouTransport.mealsOffline()
        transport.set("POST /api/meals", status: 400, body: "Total fat can't be less than saturated + trans")
        let (model, queue, store, hooks) = await queued(transport)
        var form = MealForm(day: fixtureDay)
        form.title = "Butter"
        form.fatTotal = "5"
        form.fatSaturated = "9"
        let refusal = await model.save(form, editing: nil, originalDay: nil)
        XCTAssertNil(refusal)
        XCTAssertEqual(model.pendingNotice, MealsModel.queuedNotice, "queued, not \"added\"")
        XCTAssertEqual(model.pendingNoticeLevel, .info)
        await queue.flush(.outbox)
        try await waitUntil { !model.refusedMeals.isEmpty }

        let kept = try XCTUnwrap(model.refusedMeals.first)
        XCTAssertEqual(kept.item.title, "Butter")
        XCTAssertEqual(kept.item.fatTotalG, 5)
        XCTAssertEqual(kept.item.fatSaturatedG, 9)
        XCTAssertEqual(kept.day, fixtureDay)
        XCTAssertFalse(kept.isUpdate)
        XCTAssertEqual(kept.reason, "Total fat can't be less than saturated + trans")
        XCTAssertTrue(model.pendingMeals.isEmpty, "refused is not waiting")
        let held = await store.all
        XCTAssertEqual(held.map(\.isRefused), [true])
        XCTAssertEqual(hooks.changes, 0, "nothing landed, nothing to re-read")
        XCTAssertEqual(transport.queries(tool: "get_meals").count, 1)

        // Fix: reopened from the queued row, corrected, saved again — the
        // same meal id, the refused op let go once the new one is queued.
        var fixed = MealForm(item: kept.item, day: kept.day)
        fixed.fatSaturated = "4"
        transport.set("POST /api/meals", .json(200, Data(#"{"id":"meal-new"}"#.utf8)))
        let again = await model.save(fixed, editing: nil, originalDay: nil, fixing: kept)
        XCTAssertNil(again)
        try await waitUntil { model.refusedMeals.isEmpty && model.pendingMeals.isEmpty && hooks.changes == 1 }
        XCTAssertTrue(model.refusedMeals.isEmpty)
        let posts = transport.requests("/api/meals").filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts[0].body?["id"] as? String, posts[1].body?["id"] as? String, "a refused create keeps its id")
        XCTAssertEqual(posts[1].body?["fat_saturated_g"] as? Int, 4)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        XCTAssertEqual(hooks.changes, 1)
        model.stop()
    }

    @MainActor
    func testAMealThatGivesUpBehindAKeptRefusalIsNotCalledRefused() async throws {
        // One meal refused and kept for Fix; a second meets a 5xx run and
        // gives up. The second is waiting with Retry — the toast must not
        // say "wasn't accepted" because the first still is.
        let transport = YouTransport.mealsOffline()
        transport.set("POST /api/meals", status: 400, body: "Total fat can't be less than saturated + trans")
        let (model, queue, store, _) = await queued(transport, policy: RetryPolicy(maxAttempts: 0))
        var butter = MealForm(day: fixtureDay)
        butter.title = "Butter"
        butter.fatTotal = "5"
        butter.fatSaturated = "9"
        _ = await model.save(butter, editing: nil, originalDay: nil)
        await queue.flush(.outbox)
        try await waitUntil { !model.refusedMeals.isEmpty }
        XCTAssertEqual(model.refusedMeals.map(\.item.title), ["Butter"])

        transport.set("POST /api/meals", status: 503, body: "down")
        let mark = ToastBus.shared.toasts.count
        var toast = MealForm(day: fixtureDay)
        toast.title = "Toast"
        _ = await model.save(toast, editing: nil, originalDay: nil)
        await queue.flush(.outbox)
        await queue.awaitRetries()
        try await waitUntil { model.stalledDays.contains("2026-09-08") }
        let held = await store.all
        XCTAssertEqual(held.map(\.isRefused), [true, false])
        XCTAssertEqual(held.map(\.gaveUp), [false, true])
        XCTAssertEqual(model.refusedMeals.map(\.item.title), ["Butter"], "the refusal is still the one kept")
        XCTAssertEqual(model.pendingMeals["2026-09-08"], 1, "the gave-up meal is waiting")
        XCTAssertTrue(model.stalledDays.contains("2026-09-08"), "and offered Retry")
        try await waitUntil { ToastBus.shared.toasts.count > mark }
        let since = Array(ToastBus.shared.toasts.dropFirst(mark))
        XCTAssertFalse(since.contains { $0.level == .failure }, "no refusal toast for a gave-up meal: \(since.map(\.message))")
        model.stop()
    }

    @MainActor
    func testAMealGivenUpOnThreeTimesCanBeLetGo() async throws {
        let transport = YouTransport.mealsOffline()   // no write route yet: the first try is "No connection", not a give-up
        let (model, queue, store, _) = await queued(transport, policy: RetryPolicy(maxAttempts: 0))
        var form = MealForm(day: fixtureDay)
        form.title = "Toast"
        _ = await model.save(form, editing: nil, originalDay: nil)
        await queue.flush(.outbox)
        transport.set("POST /api/meals", status: 500, body: "boom")   // a row the server will never take
        await queue.resume()
        await queue.awaitRetries()
        try await waitUntil { model.stalledDays.contains("2026-09-08") }
        XCTAssertFalse(model.letGoDays.contains("2026-09-08"), "one give-up: Retry only")
        for _ in 0..<2 {
            await queue.resume()
            await queue.awaitRetries()
        }
        try await waitUntil { model.letGoDays.contains("2026-09-08") }
        let counts = await store.all.map(\.giveUpCount)
        XCTAssertEqual(counts, [3])
        XCTAssertEqual(model.pendingMeals["2026-09-08"], 1)

        await model.letGoStalled(day: "2026-09-08")
        XCTAssertTrue(model.pendingMeals.isEmpty)
        XCTAssertTrue(model.letGoDays.isEmpty)
        XCTAssertEqual(model.refusedMeals.map(\.item.title), ["Toast"], "kept for Fix or Delete, not dropped")
        let left = await store.all.map(\.isRefused)
        XCTAssertEqual(left, [true])
        model.stop()
    }

    @MainActor
    func testALetGoMealIsKeptForFixAndTheLaneBehindItMoves() async throws {
        // Two meals queued; the server 500s the head forever. Letting it go
        // keeps it — content, day, and a reason that says the lane gave up —
        // listed with Fix and Delete as a refusal is, and the meal behind it
        // lands on the next resume. The let-go meal is never retried.
        let transport = YouTransport.mealsOffline()
        let (model, queue, store, hooks) = await queued(transport, policy: RetryPolicy(maxAttempts: 0))
        var toast = MealForm(day: fixtureDay)
        toast.title = "Toast"
        toast.protein = "12"
        var butter = MealForm(day: fixtureDay)
        butter.title = "Butter"
        _ = await model.save(toast, editing: nil, originalDay: nil)
        _ = await model.save(butter, editing: nil, originalDay: nil)
        await queue.flush(.outbox)
        transport.set("POST /api/meals", status: 500, body: "boom")
        // A resume that lands mid-flush folds into it: resume until the
        // lane has given up three times rather than counting resumes.
        for _ in 0..<8 {
            await queue.resume()
            await queue.awaitRetries()
            if let count = await store.all.first?.giveUpCount, count >= 3 { break }
        }
        try await waitUntil { model.letGoDays.contains("2026-09-08") }
        XCTAssertEqual(model.pendingMeals["2026-09-08"], 2)
        let before = await store.all
        XCTAssertEqual(before.map(\.canLetGo), [true, false], "the head gave up enough; Butter never moved")
        let giveUps = before[0].giveUpCount

        await model.letGoStalled(day: "2026-09-08")
        XCTAssertEqual(model.pendingMeals["2026-09-08"], 1, "Butter still waits")
        XCTAssertTrue(model.letGoDays.isEmpty)
        XCTAssertTrue(model.stalledDays.isEmpty)
        let kept = try XCTUnwrap(model.refusedMeals.first)
        XCTAssertEqual(model.refusedMeals.count, 1)
        XCTAssertEqual(kept.item.title, "Toast")
        XCTAssertEqual(kept.item.proteinG, 12)
        XCTAssertEqual(kept.day, fixtureDay)
        XCTAssertFalse(kept.isUpdate)
        XCTAssertEqual(kept.reason, WriteQueue.letGoReason(giveUps: giveUps))
        XCTAssertTrue(kept.reason.contains("given up after"))
        XCTAssertEqual(hooks.changes, 0, "nothing landed, nothing to re-read")

        let toastTries = transport.requests("/api/meals").filter { $0.body?["title"] as? String == "Toast" }.count
        transport.set("POST /api/meals", .json(200, Data(#"{"id":"meal-new"}"#.utf8)))
        await queue.resume()
        await queue.awaitRetries()
        try await waitUntil { model.pendingMeals.isEmpty && hooks.changes == 1 }
        XCTAssertTrue(model.pendingMeals.isEmpty)
        let posts = transport.requests("/api/meals").filter { $0.method == "POST" }
        XCTAssertEqual(posts.last?.body?["title"] as? String, "Butter", "the lane behind the let-go meal moved")
        XCTAssertEqual(posts.filter { $0.body?["title"] as? String == "Toast" }.count, toastTries, "the let-go meal was not sent again")
        let left = await store.all.map(\.isRefused)
        XCTAssertEqual(left, [true], "Toast is kept until Fix or Delete")
        XCTAssertEqual(model.refusedMeals.map(\.item.title), ["Toast"])

        await model.deleteRefused(kept.id)
        XCTAssertTrue(model.refusedMeals.isEmpty)
        let none = await store.all.count
        XCTAssertEqual(none, 0)
        model.stop()
    }

    @MainActor
    func testARefusedMealCanBeLetGo() async throws {
        let transport = YouTransport.mealsOffline()
        transport.set("POST /api/meals", status: 404, body: "Meal not found")
        let (model, queue, store, _) = await queued(transport)
        var form = MealForm(day: fixtureDay)
        form.title = "Toast"
        _ = await model.save(form, editing: nil, originalDay: nil)
        await queue.flush(.outbox)
        try await waitUntil { !model.refusedMeals.isEmpty }
        await model.deleteRefused(try XCTUnwrap(model.refusedMeals.first).id)
        XCTAssertTrue(model.refusedMeals.isEmpty)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        model.stop()
    }

    @MainActor
    func testAQueuedEditCountsBothDaysAndReReadsBothMonthsWhenItLands() async throws {
        let transport = YouTransport.mealsOffline()
        let (model, queue, store, hooks) = await queued(transport)
        let item = model.item(id: "ios-fixture-meal-1", on: fixtureDay)!
        var form = MealForm(item: item, day: fixtureDay)
        form.fiber = ""
        form.day = DayKey("2026-10-02")!
        let refusal = await model.save(form, editing: item, originalDay: fixtureDay)
        XCTAssertNil(refusal)
        await queue.flush(.outbox)
        XCTAssertEqual(model.pendingMeals, ["2026-09-08": 1, "2026-10-02": 1], "where it was and where it goes")
        let held = await store.all
        guard case .meal(let payload) = held.first?.payload else { return XCTFail("not queued") }
        XCTAssertEqual(payload.kind, .update)
        XCTAssertEqual(payload.id, "ios-fixture-meal-1")
        XCTAssertEqual(transport.requests("/api/meals").filter { $0.method == "PATCH" }.count, 1, "one try, then the lane waits")

        transport.set("PATCH /api/meals", .json(200, Data(#"{"ok":true}"#.utf8)))
        await queue.resume()
        await queue.awaitRetries()
        try await waitUntil { model.pendingMeals.isEmpty && hooks.changes == 1 }
        XCTAssertEqual(model.pendingMeals, [:])
        let patches = transport.requests("/api/meals").filter { $0.method == "PATCH" }
        XCTAssertEqual(patches.count, 2)
        XCTAssertEqual(patches[1].query, "id=ios-fixture-meal-1")
        XCTAssertTrue((patches[1].body?["fields"] as? [String: Any])?["fiber_g"] is NSNull)
        let months = transport.queries(tool: "get_meals").compactMap { ($0.body?["args"] as? [String: Any])?["start_date"] as? String }
        XCTAssertEqual(Set(months.dropFirst()), ["2026-09-01", "2026-10-01"], "both months re-read once it lands")
        XCTAssertEqual(hooks.changes, 1)
        let left = await store.all.count
        XCTAssertEqual(left, 0)
        model.stop()
    }

    @MainActor
    func testEditSendsEveryColumnAndAMoveReloadsBothMonths() async {
        let transport = YouTransport.meals()
        let (model, hooks) = await started(transport)
        let item = model.item(id: "ios-fixture-meal-1", on: fixtureDay)!
        var form = MealForm(item: item, day: fixtureDay)
        form.fiber = ""
        form.day = DayKey("2026-10-02")!
        let refusal = await model.save(form, editing: item, originalDay: fixtureDay)
        XCTAssertNil(refusal)
        let patch = transport.requests("/api/meals").last { $0.method == "PATCH" }
        XCTAssertEqual(patch?.query, "id=ios-fixture-meal-1")
        let fields = patch?.body?["fields"] as? [String: Any]
        XCTAssertEqual(fields?.count, 14, "every column, so a blank clears")
        XCTAssertTrue(fields?["fiber_g"] is NSNull)
        XCTAssertEqual(fields?["date"] as? String, "2026-10-02")
        XCTAssertEqual(fields?["calories"] as? Int, 520)
        XCTAssertEqual((patch?.body?["log"] as? [String: Any])?["meal_title"] as? String, "Fixture Oats")
        XCTAssertEqual((patch?.body?["log"] as? [String: Any])?["triggered_by"] as? String, "user")
        // September (where it was) and October (where it went).
        let months = transport.queries(tool: "get_meals").compactMap { ($0.body?["args"] as? [String: Any])?["start_date"] as? String }
        XCTAssertEqual(Set(months.dropFirst()), ["2026-09-01", "2026-10-01"])
        XCTAssertEqual(hooks.changes, 1)
        XCTAssertEqual(model.pendingNotice, "Meal updated")
    }

    @MainActor
    func testRefusalsAreTheFormsOrTheServersAndPostNothing() async {
        let transport = YouTransport.meals()
        let (model, hooks) = await started(transport)
        let blank = await model.save(MealForm(day: fixtureDay), editing: nil, originalDay: nil)
        XCTAssertEqual(blank, "Give the meal a title")
        XCTAssertTrue(transport.requests("/api/meals").isEmpty)

        transport.set("POST /api/meals", status: 400, body: "Total fat can't be less than saturated + trans")
        var form = MealForm(day: fixtureDay)
        form.title = "Butter"
        form.fatTotal = "5"
        form.fatSaturated = "9"
        let split = await model.save(form, editing: nil, originalDay: nil)
        XCTAssertEqual(split, "Total fat can't be less than saturated + trans")
        XCTAssertNil(model.pendingNotice)
        XCTAssertEqual(hooks.changes, 0)
    }

    @MainActor
    func testDeleteCarriesTheLogAndReloads() async {
        let transport = YouTransport.meals()
        let (model, hooks) = await started(transport)
        let item = model.item(id: "ios-fixture-meal-2", on: fixtureDay)!
        let refusal = await model.delete(item, on: fixtureDay)
        XCTAssertNil(refusal)
        let delete = transport.requests("/api/meals").last { $0.method == "DELETE" }
        XCTAssertEqual(delete?.query, "id=ios-fixture-meal-2")
        XCTAssertEqual((delete?.body?["log"] as? [String: Any])?["meal_title"] as? String, "Fixture Chicken Bowl")
        XCTAssertEqual(hooks.changes, 1)
        XCTAssertEqual(model.pendingNotice, "Meal deleted")
    }

    @MainActor
    func testSaveToLibraryReusesASameTitleIdAndTheNoticeIsInline() async {
        let transport = YouTransport.meals()
        let (model, _) = await started(transport)
        var form = MealForm(day: fixtureDay)
        form.title = "fixture overnight oats"
        form.calories = "400"
        let updated = await model.saveFavorite(form)
        XCTAssertNil(updated)
        var post = transport.requests("/api/meal-favorites").last { $0.method == "POST" }
        XCTAssertEqual(post?.body?["id"] as? String, "ios-fixture-fav-1", "same title, case-insensitively → the same row")
        XCTAssertNil(post?.body?["date"])
        XCTAssertNil(post?.body?["triggered_by"])
        XCTAssertEqual(model.libraryNotice, "Library favorite updated")

        form.title = "Toast"
        let saved = await model.saveFavorite(form)
        XCTAssertNil(saved)
        post = transport.requests("/api/meal-favorites").last { $0.method == "POST" }
        XCTAssertTrue((post?.body?["id"] as? String ?? "").hasPrefix("mealfav-"))
        XCTAssertEqual(model.libraryNotice, "Saved to library")
        XCTAssertEqual(transport.requests("/api/meal-favorites").filter { $0.method == "GET" }.count, 3, "re-read after each save")

        let removed = await model.deleteFavorite(model.favorites[0])
        XCTAssertNil(removed)
        XCTAssertEqual(transport.requests("/api/meal-favorites").last { $0.method == "DELETE" }?.query, "id=ios-fixture-fav-1")
        XCTAssertTrue(model.favorites.isEmpty)
        XCTAssertEqual(model.libraryNotice, "Removed from library")
        model.clearLibraryNotice()
        XCTAssertNil(model.libraryNotice)
    }

    @MainActor
    func testACachedMonthAndCachedFavoritesRenderBeforeTheNetwork() async {
        let cache = MemoryCacheStore()
        _ = await started(.meals(), cache: cache)
        let (offline, _) = await started(YouTransport(), cache: cache)
        XCTAssertEqual(offline.meals(on: fixtureDay)?.mealCount, 2)
        XCTAssertEqual(offline.favorites.count, 1)
    }
}
