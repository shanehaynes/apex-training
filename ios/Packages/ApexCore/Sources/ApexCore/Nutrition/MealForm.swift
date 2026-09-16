import Foundation

/// The meal composer's value type (`AddMealView.tsx`): the fields as typed,
/// the parse that mirrors the web's `parseForm`, and the rows the two writes
/// send. The fat-split rule is deliberately NOT checked here — the server
/// refuses it with the composer's own sentence, which the sheet shows inline.
public struct MealForm: Sendable, Equatable {
    public var title = ""
    public var day: DayKey
    /// Minutes since midnight; nil when no time is set.
    public var timeMinutes: Int?
    /// One of `MealForm.types`, or nil.
    public var mealType: String?
    public var calories = ""
    public var protein = ""
    public var carbs = ""
    public var fiber = ""
    public var sugar = ""
    public var fatTotal = ""
    public var fatSaturated = ""
    public var fatTrans = ""
    public var alcohol = ""
    public var notes = ""

    public static let types = ["breakfast", "lunch", "dinner", "snack"]

    public init(day: DayKey) {
        self.day = day
    }

    /// The composer opened on a logged meal.
    public init(item: MealsQueryResult.Item, day: DayKey) {
        self.day = day
        title = item.title
        timeMinutes = item.time.flatMap(TimeLabel.minutes)
        mealType = item.mealType
        calories = MealForm.text(item.calories)
        protein = MealForm.text(item.proteinG)
        carbs = MealForm.text(item.carbsG)
        fiber = MealForm.text(item.fiberG)
        sugar = MealForm.text(item.sugarG)
        fatTotal = MealForm.text(item.fatTotalG)
        fatSaturated = MealForm.text(item.fatSaturatedG)
        fatTrans = MealForm.text(item.fatTransG)
        alcohol = MealForm.text(item.alcoholG)
        notes = item.notes ?? ""
    }

    /// Fill from a favorite — everything but the calendar placement.
    public mutating func apply(_ favorite: MealFavorite) {
        title = favorite.title
        mealType = favorite.mealType
        calories = MealForm.text(favorite.calories)
        protein = MealForm.text(favorite.proteinG)
        carbs = MealForm.text(favorite.carbsG)
        fiber = MealForm.text(favorite.fiberG)
        sugar = MealForm.text(favorite.sugarG)
        fatTotal = MealForm.text(favorite.fatTotalG)
        fatSaturated = MealForm.text(favorite.fatSaturatedG)
        fatTrans = MealForm.text(favorite.fatTransG)
        alcohol = MealForm.text(favorite.alcoholG)
        notes = favorite.notes
    }

    /// The Atwater placeholder for the Calories field while it is blank.
    public var derivedCalories: Int? {
        Nutrition.derivedCalories(
            proteinG: MealForm.grams(protein).value, carbsG: MealForm.grams(carbs).value,
            fatTotalG: MealForm.grams(fatTotal).value, alcoholG: MealForm.grams(alcohol).value
        )
    }

    /// The parsed macros, or the first refusal — the composer's words.
    public struct Parsed: Sendable, Equatable {
        public let title: String
        public let mealType: String?
        public let calories: Double?
        public let proteinG: Double?
        public let carbsG: Double?
        public let fiberG: Double?
        public let sugarG: Double?
        public let fatTotalG: Double?
        public let fatSaturatedG: Double?
        public let fatTransG: Double?
        public let alcoholG: Double?
        public let notes: String
    }

    public enum Outcome: Sendable, Equatable {
        case ok(Parsed)
        case problem(String)
    }

    public static let titleProblem = "Give the meal a title"

    public func parse() -> Outcome {
        let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
        if trimmedTitle.isEmpty { return .problem(MealForm.titleProblem) }
        let fields: [(label: String, text: String)] = [
            ("Calories", calories), ("Protein", protein), ("Carbs", carbs), ("Fiber", fiber), ("Sugar", sugar),
            ("Total fat", fatTotal), ("Saturated fat", fatSaturated), ("Trans fat", fatTrans), ("Alcohol", alcohol),
        ]
        var values: [Double?] = []
        for field in fields {
            let grams = MealForm.grams(field.text)
            if grams.invalid { return .problem("\(field.label) must be a number of at least 0") }
            values.append(grams.value)
        }
        return .ok(Parsed(
            title: trimmedTitle, mealType: mealType,
            calories: values[0], proteinG: values[1], carbsG: values[2], fiberG: values[3], sugarG: values[4],
            fatTotalG: values[5], fatSaturatedG: values[6], fatTransG: values[7], alcoholG: values[8],
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
    }

    /// The flat row `POST /api/meals` inserts. The time is stored in the
    /// display convention (`"5:30 PM"`), as the web stores it.
    public func row(id: String, parsed: Parsed) -> [String: JSONValue] {
        var row = MealForm.columns(parsed)
        row["id"] = .string(id)
        row["date"] = .string(day.string)
        row["time"] = timeMinutes.map { .string(TimeLabel.stored(minutes: $0)) } ?? .null
        return row
    }

    /// The `fields` a PATCH sends: every column, on purpose — a field blanked
    /// in the editor must CLEAR its column, and the server only clears a key
    /// it was sent as null.
    public func fields(parsed: Parsed) -> [String: JSONValue] {
        var fields = MealForm.columns(parsed)
        fields["date"] = .string(day.string)
        fields["time"] = timeMinutes.map { .string(TimeLabel.stored(minutes: $0)) } ?? .null
        return fields
    }

    /// The favorite row `POST /api/meal-favorites` upserts: the meal minus its placement.
    public func favoriteRow(id: String, parsed: Parsed) -> [String: JSONValue] {
        var row = MealForm.columns(parsed)
        row["id"] = .string(id)
        return row
    }

    private static func columns(_ p: Parsed) -> [String: JSONValue] {
        let number: (Double?) -> JSONValue = { $0.map(JSONValue.number) ?? .null }
        return [
            "title": .string(p.title),
            "meal_type": p.mealType.map(JSONValue.string) ?? .null,
            "calories": number(p.calories),
            "protein_g": number(p.proteinG),
            "carbs_g": number(p.carbsG),
            "fiber_g": number(p.fiberG),
            "sugar_g": number(p.sugarG),
            "fat_total_g": number(p.fatTotalG),
            "fat_saturated_g": number(p.fatSaturatedG),
            "fat_trans_g": number(p.fatTransG),
            "alcohol_g": number(p.alcoholG),
            "notes": .string(p.notes),
        ]
    }

    /// `parseGrams`: blank → unset; else a finite number of at least zero, or invalid.
    static func grams(_ text: String) -> (value: Double?, invalid: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return (nil, false) }
        guard let n = Double(trimmed), n.isFinite, n >= 0 else { return (nil, true) }
        return (n, false)
    }

    static func text(_ value: Double?) -> String {
        guard let value else { return "" }
        return value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }
}
