import Foundation

/// `POST /api/query { tool: "get_meals", args: { start_date, end_date, include_items } }`
/// (`api/_lib/mcp/tools/meals.ts`). The server sums the macros — including the
/// Atwater fallback for meals with no stored calories — so the app never adds
/// grams up itself (`src/lib/nutrition` has the tests).
public struct MealsQueryResult: Codable, Sendable, Equatable {
    public let startDate: String
    public let endDate: String
    public let days: [Day]

    enum CodingKeys: String, CodingKey {
        case startDate = "start_date"
        case endDate = "end_date"
        case days
    }

    public struct Day: Codable, Sendable, Equatable {
        public let date: String
        public let mealCount: Int
        public let totals: Totals
        /// Present only when the query asked for `include_items`.
        public let meals: [Item]?

        enum CodingKeys: String, CodingKey {
            case date
            case mealCount = "meal_count"
            case totals, meals
        }
    }

    /// Display-rounded by the server: whole calories, tenth-gram macros.
    public struct Totals: Codable, Sendable, Equatable {
        public let calories: Double
        public let proteinG: Double
        public let carbsG: Double
        public let fatTotalG: Double
    }

    /// One logged meal. Since W10 it carries its `id` (the phone edits and
    /// deletes through `/api/meals?id=`) and the whole stored fat split, so
    /// the composer can reopen it exactly as it was saved. Both are optional
    /// in the decoder so a response from before W10 still reads.
    public struct Item: Codable, Sendable, Equatable {
        public let id: String?
        public let title: String
        public let time: String?
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
        public let notes: String?

        enum CodingKeys: String, CodingKey {
            case id, title, time, calories, notes
            case mealType = "meal_type"
            case proteinG = "protein_g"
            case carbsG = "carbs_g"
            case fiberG = "fiber_g"
            case sugarG = "sugar_g"
            case fatTotalG = "fat_total_g"
            case fatSaturatedG = "fat_saturated_g"
            case fatTransG = "fat_trans_g"
            case alcoholG = "alcohol_g"
        }

        public init(
            id: String? = nil, title: String, time: String? = nil, mealType: String? = nil, calories: Double? = nil,
            proteinG: Double? = nil, carbsG: Double? = nil, fiberG: Double? = nil, sugarG: Double? = nil,
            fatTotalG: Double? = nil, fatSaturatedG: Double? = nil, fatTransG: Double? = nil, alcoholG: Double? = nil,
            notes: String? = nil
        ) {
            self.id = id
            self.title = title
            self.time = time
            self.mealType = mealType
            self.calories = calories
            self.proteinG = proteinG
            self.carbsG = carbsG
            self.fiberG = fiberG
            self.sugarG = sugarG
            self.fatTotalG = fatTotalG
            self.fatSaturatedG = fatSaturatedG
            self.fatTransG = fatTransG
            self.alcoholG = alcoholG
            self.notes = notes
        }
    }

    /// Arguments for the query, dated `YYYY-MM-DD`; the server caps a call at 31 days.
    public static func args(startDate: String, endDate: String, includeItems: Bool = true) -> [String: JSONValue] {
        [
            "start_date": .string(startDate),
            "end_date": .string(endDate),
            "include_items": .bool(includeItems),
        ]
    }
}

/// A meal template (`GET /api/meal-favorites`, W10): the same fields minus
/// the calendar placement, camelCase because the server maps the row
/// (`rowToFavorite`) before answering. Ids are `mealfav-<uuid>`, minted on
/// the phone the way the web mints them; a same-title save reuses the
/// existing id so "save again" overwrites rather than duplicates.
public struct MealFavorite: Codable, Sendable, Equatable, Identifiable {
    public let id: String
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

    public init(
        id: String, title: String, mealType: String? = nil, calories: Double? = nil, proteinG: Double? = nil,
        carbsG: Double? = nil, fiberG: Double? = nil, sugarG: Double? = nil, fatTotalG: Double? = nil,
        fatSaturatedG: Double? = nil, fatTransG: Double? = nil, alcoholG: Double? = nil, notes: String = ""
    ) {
        self.id = id
        self.title = title
        self.mealType = mealType
        self.calories = calories
        self.proteinG = proteinG
        self.carbsG = carbsG
        self.fiberG = fiberG
        self.sugarG = sugarG
        self.fatTotalG = fatTotalG
        self.fatSaturatedG = fatSaturatedG
        self.fatTransG = fatTransG
        self.alcoholG = alcoholG
        self.notes = notes
    }
}

public struct MealFavoritesResponse: Codable, Sendable, Equatable {
    public let favorites: [MealFavorite]
}

/// The ids the web mints for meals and favorites (`MealsContext.tsx`).
public enum MealID {
    public static func mint() -> String { "meal-" + UUID().uuidString.lowercased() }
    public static func mintFavorite() -> String { "mealfav-" + UUID().uuidString.lowercased() }
}
