import ApexCore
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
