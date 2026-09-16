import ApexCore
import ApexFeatures
import Foundation

/// Counts the hook the schedule is handed (W10): a write from the meals model
/// re-reads the schedule's own months.
@MainActor
final class MealsHooks {
    var changes = 0
}

extension YouTransport {
    /// Every meals route answered from its fixture.
    static func meals() -> YouTransport {
        let t = YouTransport()
        t.set("POST /api/query get_meals", .json(200, fixture("query-get_meals.json")))
        t.set("GET /api/meal-favorites", .json(200, fixture("meal-favorites.json")))
        t.set("POST /api/meals", .json(200, Data(#"{"id":"meal-new"}"#.utf8)))
        t.set("PATCH /api/meals", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("DELETE /api/meals", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("POST /api/meal-favorites", .json(200, Data(#"{"id":"fav"}"#.utf8)))
        t.set("DELETE /api/meal-favorites", .json(200, Data(#"{"ok":true}"#.utf8)))
        return t
    }
}

@MainActor
func makeMealsModel(_ transport: YouTransport, hooks: MealsHooks, cache: any CacheStore = MemoryCacheStore()) -> MealsModel {
    let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
    return MealsModel(deps: MealsDependencies(
        client: client, cache: cache, clock: TestClock(now: coachTestNow), timeZone: TimeZone(identifier: "UTC")!,
        onMealsChanged: { hooks.changes += 1 }
    ))
}
