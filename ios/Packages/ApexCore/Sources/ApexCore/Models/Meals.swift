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

    public struct Item: Codable, Sendable, Equatable {
        public let title: String
        public let time: String?
        public let mealType: String?
        public let calories: Double?
        public let proteinG: Double?
        public let carbsG: Double?
        public let fiberG: Double?
        public let sugarG: Double?
        public let fatTotalG: Double?
        public let notes: String?

        enum CodingKeys: String, CodingKey {
            case title, time, calories, notes
            case mealType = "meal_type"
            case proteinG = "protein_g"
            case carbsG = "carbs_g"
            case fiberG = "fiber_g"
            case sugarG = "sugar_g"
            case fatTotalG = "fat_total_g"
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
