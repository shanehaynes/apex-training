import XCTest
@testable import ApexCore

/// The Library, Blocks and Meals write surface (W10), byte for byte. Every
/// body carries user attribution — omitted, the server charges the AI
/// mutation cap or defaults the audit row to `ai` — and every cleared column
/// is an explicit null, so a typo here is a silent no-op the compiler cannot see.
final class W10EndpointTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:5314")!
    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }

    // MARK: - Blocks

    func testCyclePreviewPostsTheSpecUnderTheCycleResource() {
        let spec = CycleSpec(startDate: "2027-01-06", namePrefix: "Spring", weeklyTargets: WeeklyTargets(cardioMinutes: 300))
        let preview = Endpoint.cyclePreview(spec: spec)
        XCTAssertEqual(preview.method, .post)
        XCTAssertEqual(preview.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/blocks?resource=cycle")
        XCTAssertEqual(body(preview),
                       #"{"spec":{"cycles":4,"namePrefix":"Spring","recoveryScale":0.5,"startDate":"2027-01-06","weeklyTargets":{"cardioMinutes":300},"weeksOff":1,"weeksOn":3}}"#)
    }

    /// The rows are the server's own from the preview and go back untouched;
    /// the log names the first block, as the web does.
    func testCreateBlocksSendsTheServersRowsVerbatim() {
        let rows: [JSONValue] = [.object(["name": .string("Spring · Build 1"), "start_date": .string("2027-01-04")])]
        let commit = Endpoint.createBlocks(rows: rows, firstName: "Spring · Build 1")
        XCTAssertEqual(commit.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/blocks?batch=1")
        XCTAssertEqual(body(commit),
                       #"{"log":{"resource_name":"Spring · Build 1","triggered_by":"user"},"rows":[{"name":"Spring · Build 1","start_date":"2027-01-04"}]}"#)
    }

    func testBlockWritesCarryAttributionAndExplicitNulls() {
        var form = BlockForm(startDay: DayKey("2026-09-09")!, endInclusive: DayKey("2026-10-04")!)
        form.name = " Base "
        form.cardioMinutes = "240"
        form.vert = "3000"
        let create = Endpoint.createBlock(row: form.row(), name: "Base")
        XCTAssertEqual(create.method, .post)
        XCTAssertEqual(create.path, "api/blocks")
        XCTAssertEqual(body(create),
                       #"{"end_date_exclusive":"2026-10-05","intent":"","log":{"resource_name":"Base","triggered_by":"user"},"name":"Base","objective_id":null,"phase":null,"start_date":"2026-09-07","triggered_by":"user","weekly_targets":{"cardioMinutes":240,"vert":{"unit":"ft","value":3000}}}"#)

        let update = Endpoint.updateBlock(id: "blk-1", fields: ["phase": .null, "objective_id": .string("obj-1")], name: "Base")
        XCTAssertEqual(update.method, .patch)
        XCTAssertEqual(update.url(relativeTo: base)?.query, "id=blk-1")
        XCTAssertEqual(body(update), #"{"fields":{"objective_id":"obj-1","phase":null},"log":{"resource_name":"Base","triggered_by":"user"}}"#)

        let delete = Endpoint.deleteBlock(id: "blk-1", name: "Base")
        XCTAssertEqual(delete.method, .delete)
        XCTAssertEqual(delete.url(relativeTo: base)?.query, "id=blk-1")
        XCTAssertEqual(body(delete), #"{"log":{"resource_name":"Base","triggered_by":"user"}}"#)
    }

    func testCreateObjectiveFixesTheColumnsTheWebFixes() {
        XCTAssertEqual(body(Endpoint.createObjective(name: "Rainier", targetDate: "2027-07-01", discipline: "alpine")),
                       #"{"discipline":"alpine","log":{"resource_name":"Rainier","triggered_by":"user"},"name":"Rainier","notes":"","required_capabilities":[],"status":"active","target_date":"2027-07-01","triggered_by":"user"}"#)
        XCTAssertEqual(body(Endpoint.createObjective(name: "Someday", targetDate: nil, discipline: nil)),
                       #"{"discipline":null,"log":{"resource_name":"Someday","triggered_by":"user"},"name":"Someday","notes":"","required_capabilities":[],"status":"active","target_date":null,"triggered_by":"user"}"#)
    }

    // MARK: - Library

    func testDefinitionUpdateLogsTheNameAndCarriesOnlyTheChangedColumns() {
        let update = Endpoint.updateDefinition(id: "bench", fields: ["canonical_name": .string("Bench Press")], name: "Bench")
        XCTAssertEqual(update.method, .patch)
        XCTAssertEqual(update.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/exercise-definitions?id=bench")
        XCTAssertEqual(body(update), #"{"fields":{"canonical_name":"Bench Press"},"log":{"definition_name":"Bench","triggered_by":"user"}}"#)

        XCTAssertEqual(body(Endpoint.updateDefinition(id: "bench", fields: ["archived_at": .null], name: "Bench")),
                       #"{"fields":{"archived_at":null},"log":{"definition_name":"Bench","triggered_by":"user"}}"#)
    }

    // MARK: - Meals

    func testMealWritesCarryEveryColumnAndAttribution() {
        var form = MealForm(day: DayKey("2026-09-08")!)
        form.title = "Oats"
        form.timeMinutes = 7 * 60 + 15
        form.mealType = "breakfast"
        form.protein = "22"
        form.carbs = "78"
        form.fatTotal = "12"
        guard case .ok(let parsed) = form.parse() else { return XCTFail("parse") }

        let create = Endpoint.createMeal(row: form.row(id: "meal-1", parsed: parsed))
        XCTAssertEqual(create.method, .post)
        XCTAssertEqual(create.path, "api/meals")
        XCTAssertEqual(body(create),
                       #"{"alcohol_g":null,"calories":null,"carbs_g":78,"date":"2026-09-08","fat_saturated_g":null,"fat_total_g":12,"fat_trans_g":null,"fiber_g":null,"id":"meal-1","meal_type":"breakfast","notes":"","protein_g":22,"sugar_g":null,"time":"7:15 AM","title":"Oats","triggered_by":"user"}"#)

        let update = Endpoint.updateMeal(id: "meal-1", fields: form.fields(parsed: parsed), title: "Oats")
        XCTAssertEqual(update.method, .patch)
        XCTAssertEqual(update.url(relativeTo: base)?.query, "id=meal-1")
        XCTAssertTrue(body(update).hasPrefix(#"{"fields":{"alcohol_g":null,"calories":null,"carbs_g":78,"date":"2026-09-08""#), body(update))
        XCTAssertTrue(body(update).hasSuffix(#""log":{"meal_title":"Oats","triggered_by":"user"}}"#), body(update))
        XCTAssertFalse(body(update).contains(#""id":"#))

        let delete = Endpoint.deleteMeal(id: "meal-1", title: "Oats")
        XCTAssertEqual(delete.method, .delete)
        XCTAssertEqual(body(delete), #"{"log":{"meal_title":"Oats","triggered_by":"user"}}"#)
    }

    func testFavoritesReadIsAPlainGetAndTheWritesCarryNoAttribution() {
        XCTAssertEqual(Endpoint.mealFavorites.method, .get)
        XCTAssertNil(Endpoint.mealFavorites.body)
        XCTAssertEqual(Endpoint.mealFavorites.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/meal-favorites")

        var form = MealForm(day: DayKey("2026-09-08")!)
        form.title = "Oats"
        form.calories = "420"
        guard case .ok(let parsed) = form.parse() else { return XCTFail("parse") }
        let save = Endpoint.saveMealFavorite(row: form.favoriteRow(id: "mealfav-1", parsed: parsed))
        XCTAssertEqual(save.method, .post)
        let text = body(save)
        XCTAssertTrue(text.hasPrefix(#"{"alcohol_g":null,"calories":420,"#), text)
        XCTAssertFalse(text.contains("date"))
        XCTAssertFalse(text.contains("triggered_by"))

        let delete = Endpoint.deleteMealFavorite(id: "mealfav-1")
        XCTAssertEqual(delete.method, .delete)
        XCTAssertEqual(delete.url(relativeTo: base)?.query, "id=mealfav-1")
        XCTAssertNil(delete.body)
    }
}
