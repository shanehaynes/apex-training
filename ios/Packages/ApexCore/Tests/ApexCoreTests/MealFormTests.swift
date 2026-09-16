import XCTest
@testable import ApexCore

/// The meal composer's parse and rows (W10), mirroring `AddMealView.parseForm`.
/// The fat-split rule is absent on purpose: the server refuses it.
final class MealFormTests: XCTestCase {
    private let day = DayKey("2026-09-08")!

    func testATitleIsRequiredAndMacrosMustBeNumbersOfAtLeastZero() {
        var form = MealForm(day: day)
        XCTAssertEqual(form.parse(), .problem("Give the meal a title"))

        form.title = "Oats"
        form.protein = "-1"
        XCTAssertEqual(form.parse(), .problem("Protein must be a number of at least 0"))
        form.protein = "twenty"
        XCTAssertEqual(form.parse(), .problem("Protein must be a number of at least 0"))
        form.protein = ""
        form.fatTrans = "x"
        XCTAssertEqual(form.parse(), .problem("Trans fat must be a number of at least 0"))

        // Saturated above total parses fine here — that is the server's call.
        form.fatTrans = ""
        form.fatTotal = "5"
        form.fatSaturated = "9"
        guard case .ok(let parsed) = form.parse() else { return XCTFail("expected ok") }
        XCTAssertEqual(parsed.fatTotalG, 5)
        XCTAssertEqual(parsed.fatSaturatedG, 9)
        XCTAssertNil(parsed.proteinG)
    }

    func testDerivedCaloriesFollowTheMacrosAsTyped() {
        var form = MealForm(day: day)
        XCTAssertNil(form.derivedCalories)
        form.protein = "48"
        form.carbs = "60"
        form.fatTotal = "18"
        XCTAssertEqual(form.derivedCalories, 594)
        form.alcohol = "10"
        XCTAssertEqual(form.derivedCalories, 664)
        form.protein = "bad"
        // An unparsable field counts as unset for the placeholder; parse() refuses it.
        XCTAssertEqual(form.derivedCalories, 472)
    }

    func testPatchFieldsCarryEveryColumnSoABlankClears() {
        var form = MealForm(day: day)
        form.title = "Oats"
        form.calories = "520"
        guard case .ok(let parsed) = form.parse() else { return XCTFail("expected ok") }
        let fields = form.fields(parsed: parsed)
        XCTAssertEqual(fields.count, 14)
        XCTAssertEqual(fields["calories"], .number(520))
        XCTAssertEqual(fields["protein_g"], .null)
        XCTAssertEqual(fields["meal_type"], .null)
        XCTAssertEqual(fields["time"], .null)
        XCTAssertEqual(fields["date"], .string("2026-09-08"))
        XCTAssertNil(fields["id"])
    }

    func testTimeIsStoredInTheDisplayConventionAndReadBackFromEither() {
        var form = MealForm(day: day)
        form.title = "Dinner"
        form.timeMinutes = 17 * 60 + 30
        guard case .ok(let parsed) = form.parse() else { return XCTFail("expected ok") }
        XCTAssertEqual(form.row(id: "meal-2", parsed: parsed)["time"], .string("5:30 PM"))

        let stored = MealsQueryResult.Item(id: "meal-2", title: "Dinner", time: "5:30 PM", fatTotalG: 20, fatSaturatedG: 5)
        let reopened = MealForm(item: stored, day: day)
        XCTAssertEqual(reopened.timeMinutes, 17 * 60 + 30)
        XCTAssertEqual(reopened.fatTotal, "20")
        XCTAssertEqual(reopened.fatSaturated, "5")
        XCTAssertEqual(reopened.fatTrans, "")
        let newer = MealsQueryResult.Item(title: "Lunch", time: "12:45")
        XCTAssertEqual(MealForm(item: newer, day: day).timeMinutes, 12 * 60 + 45)
    }

    func testApplyingAFavoriteFillsEverythingButThePlacement() {
        var form = MealForm(day: day)
        form.timeMinutes = 60
        form.apply(MealFavorite(id: "mealfav-1", title: "Overnight Oats", mealType: "breakfast", calories: 420, proteinG: 18, carbsG: 60, fatTotalG: 12, notes: "Prep the night before"))
        XCTAssertEqual(form.title, "Overnight Oats")
        XCTAssertEqual(form.mealType, "breakfast")
        XCTAssertEqual(form.calories, "420")
        XCTAssertEqual(form.protein, "18")
        XCTAssertEqual(form.fatSaturated, "")
        XCTAssertEqual(form.notes, "Prep the night before")
        XCTAssertEqual(form.timeMinutes, 60)
        XCTAssertEqual(form.day, day)

        guard case .ok(let parsed) = form.parse() else { return XCTFail("expected ok") }
        let favorite = form.favoriteRow(id: "mealfav-1", parsed: parsed)
        XCTAssertEqual(favorite["id"], .string("mealfav-1"))
        XCTAssertNil(favorite["date"])
        XCTAssertNil(favorite["time"])
    }

    func testMintedIdsCarryTheWebsPrefixes() {
        XCTAssertTrue(MealID.mint().hasPrefix("meal-"))
        XCTAssertTrue(MealID.mintFavorite().hasPrefix("mealfav-"))
        XCTAssertEqual(MealID.mint().count, "meal-".count + 36)
    }
}
