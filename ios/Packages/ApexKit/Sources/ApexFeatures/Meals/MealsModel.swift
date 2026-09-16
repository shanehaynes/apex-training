import ApexCore
import ApexUI
import Foundation
import Observation

/// What the Meals screens need (W10): the client, the cache (`meals_window`
/// per month, shared with the schedule), the clock and zone, the realtime
/// hub for the `meals` group, and the hook that tells the schedule a meal
/// changed so its Day view follows at once.
public struct MealsDependencies: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var clock: any ApexClock
    public var realtime: (any RealtimeChanges)?
    public var timeZone: TimeZone
    public var onMealsChanged: @MainActor @Sendable () async -> Void

    public init(
        client: ApexClient, cache: any CacheStore, clock: any ApexClock = SystemClock(),
        realtime: (any RealtimeChanges)? = nil, timeZone: TimeZone = .current,
        onMealsChanged: @escaping @MainActor @Sendable () async -> Void = {}
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.realtime = realtime
        self.timeZone = timeZone
        self.onMealsChanged = onMealsChanged
    }
}

/// Meals and the favorites library (`AddMealView.tsx`, `DayModal.tsx`): the
/// day's meals from `get_meals` per month (the server sums the macros), the
/// composer's writes, the favorites the composer fills from. One instance
/// serves both tabs — the composer is presented from Schedule and from You.
@MainActor
@Observable
public final class MealsModel {
    public let deps: MealsDependencies

    public private(set) var mealsByDay: [DayKey: MealsQueryResult.Day] = [:]
    public private(set) var favorites: [MealFavorite] = []
    public private(set) var favoritesLoaded = false
    /// A success message for the screen under a closing sheet to toast.
    public private(set) var pendingNotice: String?
    /// "Saved to library" and friends: the sheet stays open, so the message
    /// is inline text in it, never a toast (a success toast is as hidden
    /// under a sheet as a failure, #167).
    public private(set) var libraryNotice: String?
    public var selectedDay: DayKey

    private var monthsLoaded: Set<String> = []
    private var isStarted = false
    private var realtimeTask: Task<Void, Never>?

    public init(deps: MealsDependencies) {
        self.deps = deps
        selectedDay = DayKey.today(clock: deps.clock, timeZone: deps.timeZone)
    }

    // Under MainActor default isolation the deinit would be synthesized as
    // *isolated*, which routes deallocation through swift_task_deinitOnExecutor
    // and aborts on the iOS 17/18 runtime when the object dies outside a task
    // (swiftlang/swift#87316, D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

    public var today: DayKey { DayKey.today(clock: deps.clock, timeZone: deps.timeZone) }

    // MARK: - Lifecycle

    /// Favorites from the cache then the network, the selected month, then
    /// realtime. Idempotent.
    public func start() async {
        guard !isStarted else { return }
        isStarted = true
        if let entry = try? await deps.cache.read(kind: .mealFavorites, key: ScheduleCacheKey.mealFavorites),
           let cached = try? JSONDecoder().decode(MealFavoritesResponse.self, from: entry.json) {
            favorites = cached.favorites
            favoritesLoaded = true
        }
        await loadFavorites()
        await loadMonth(for: selectedDay)
        if let realtime = deps.realtime {
            await realtime.subscribe(.meals)
            realtimeTask = Task { [weak self] in
                for await group in realtime.changes {
                    guard let self, !Task.isCancelled else { return }
                    if group == .meals {
                        self.monthsLoaded.removeAll()
                        await self.loadMonth(for: self.selectedDay)
                        await self.loadFavorites()
                    }
                }
            }
        }
    }

    public func stop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        if let realtime = deps.realtime {
            Task { await realtime.unsubscribe(.meals) }
        }
    }

    // MARK: - Reads

    public func meals(on day: DayKey) -> MealsQueryResult.Day? { mealsByDay[day] }

    public func item(id: String, on day: DayKey) -> MealsQueryResult.Item? {
        mealsByDay[day]?.meals?.first { $0.id == id }
    }

    /// The month around `day`, cache first (`ScheduleModel.loadMeals` twin —
    /// the two share the entries by key, so one on-disk copy serves both).
    public func loadMonth(for day: DayKey) async {
        let key = ScheduleCacheKey.meals(year: day.year, month: day.month)
        guard !monthsLoaded.contains(key) else { return }
        monthsLoaded.insert(key)
        if let entry = try? await deps.cache.read(kind: .mealsWindow, key: key),
           let cached = try? JSONDecoder().decode(QueryEnvelope<MealsQueryResult>.self, from: entry.json) {
            apply(cached.result)
        }
        let start = day.monthStart
        let end = DayKey(year: day.year, month: day.month, day: DayKey.daysInMonth(year: day.year, month: day.month))
        do {
            let data = try await deps.client.data(for: .query(
                tool: "get_meals", args: MealsQueryResult.args(startDate: start.string, endDate: end.string)
            ))
            let envelope = try JSONDecoder().decode(QueryEnvelope<MealsQueryResult>.self, from: data)
            for (k, _) in mealsByDay where k.year == day.year && k.month == day.month { mealsByDay[k] = nil }
            apply(envelope.result)
            try? await deps.cache.write(CacheEntry(kind: .mealsWindow, key: key, json: data, fetchedAt: deps.clock.now))
        } catch {
            monthsLoaded.remove(key)
        }
    }

    private func apply(_ result: MealsQueryResult) {
        for day in result.days {
            if let key = DayKey(day.date) { mealsByDay[key] = day }
        }
    }

    /// Re-read the months of these days (after a write that moved or made a meal).
    private func reload(days: [DayKey]) async {
        for day in days {
            monthsLoaded.remove(ScheduleCacheKey.meals(year: day.year, month: day.month))
        }
        for day in Set(days.map { DayKey(year: $0.year, month: $0.month, day: 1) }) {
            await loadMonth(for: day)
        }
    }

    public func select(_ day: DayKey) {
        selectedDay = day
    }

    public func goToToday() { selectedDay = today }

    public func loadFavorites() async {
        do {
            let response = try await deps.client.send(.mealFavorites, as: MealFavoritesResponse.self)
            favorites = response.favorites
            favoritesLoaded = true
            if let json = try? JSONEncoder().encode(response) {
                try? await deps.cache.write(CacheEntry(kind: .mealFavorites, key: ScheduleCacheKey.mealFavorites, json: json, fetchedAt: deps.clock.now))
            }
        } catch {
            // The row of chips is simply absent; the next open retries.
        }
    }

    // MARK: - Labels

    /// "1114 kcal · P 70 / C 138 / F 30" — the Day view's roll-up.
    public static func rollup(_ day: MealsQueryResult.Day?) -> String {
        guard let day, day.mealCount > 0 else { return "No meals logged" }
        let t = day.totals
        return "\(Int(t.calories)) kcal · P \(grams(t.proteinG)) / C \(grams(t.carbsG)) / F \(grams(t.fatTotalG))"
    }

    /// "620 kcal · P 42 / C 55 / F 24" (`mealSummary` in DayModal.tsx).
    public static func summary(_ meal: MealsQueryResult.Item) -> String {
        var parts: [String] = []
        if let kcal = meal.calories { parts.append("\(Int(kcal.rounded())) kcal") }
        var macros: [String] = []
        if let p = meal.proteinG { macros.append("P \(grams(p))") }
        if let c = meal.carbsG { macros.append("C \(grams(c))") }
        if let f = meal.fatTotalG { macros.append("F \(grams(f))") }
        if !macros.isEmpty { parts.append(macros.joined(separator: " / ")) }
        return parts.isEmpty ? "No macros" : parts.joined(separator: " · ")
    }

    static func grams(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }

    // MARK: - Writes

    /// The composer's save: create, or every column of an edit (a blanked
    /// field clears). nil = saved; a message = the refusal — the form's own
    /// (a missing title, a bad number) or the server's (the fat split).
    public func save(_ form: MealForm, editing: MealsQueryResult.Item?, originalDay: DayKey?) async -> String? {
        guard case .ok(let parsed) = form.parse() else {
            if case .problem(let text) = form.parse() { return text }
            return nil
        }
        do {
            if let editing, let id = editing.id {
                _ = try await deps.client.data(for: .updateMeal(id: id, fields: form.fields(parsed: parsed), title: parsed.title))
            } else {
                _ = try await deps.client.data(for: .createMeal(row: form.row(id: MealID.mint(), parsed: parsed)))
            }
        } catch {
            return Failure.message(error)
        }
        pendingNotice = editing == nil ? "Meal added" : "Meal updated"
        await reload(days: [form.day] + (originalDay.map { [$0] } ?? []))
        await deps.onMealsChanged()
        return nil
    }

    public func delete(_ item: MealsQueryResult.Item, on day: DayKey) async -> String? {
        guard let id = item.id else { return "That meal cannot be deleted from here." }
        do {
            _ = try await deps.client.data(for: .deleteMeal(id: id, title: item.title))
        } catch {
            return Failure.message(error)
        }
        pendingNotice = "Meal deleted"
        await reload(days: [day])
        await deps.onMealsChanged()
        return nil
    }

    /// Save the form as a favorite. A same-title favorite (case-insensitive)
    /// is overwritten, not duplicated — the web reuses its id.
    public func saveFavorite(_ form: MealForm) async -> String? {
        guard case .ok(let parsed) = form.parse() else {
            if case .problem(let text) = form.parse() { return text }
            return nil
        }
        let existing = favorites.first { $0.title.lowercased() == parsed.title.lowercased() }
        let id = existing?.id ?? MealID.mintFavorite()
        do {
            _ = try await deps.client.data(for: .saveMealFavorite(row: form.favoriteRow(id: id, parsed: parsed)))
        } catch {
            return Failure.message(error)
        }
        await loadFavorites()
        libraryNotice = existing == nil ? "Saved to library" : "Library favorite updated"
        return nil
    }

    public func deleteFavorite(_ favorite: MealFavorite) async -> String? {
        do {
            _ = try await deps.client.data(for: .deleteMealFavorite(id: favorite.id))
        } catch {
            return Failure.message(error)
        }
        favorites.removeAll { $0.id == favorite.id }
        libraryNotice = "Removed from library"
        return nil
    }

    public func clearLibraryNotice() { libraryNotice = nil }

    /// The screen under a closed sheet posts what the sheet could not.
    public func flushNotice() {
        guard let notice = pendingNotice else { return }
        pendingNotice = nil
        ToastBus.shared.post(notice, level: .success)
    }
}

/// What the composer opens on: a new meal on a day, or one to edit.
public enum MealComposerRoute: Identifiable, Hashable, Sendable {
    case create(DayKey)
    case edit(day: DayKey, item: MealsQueryResult.Item)

    public var id: String {
        switch self {
        case .create(let day): "create:\(day.string)"
        case .edit(let day, let item): "edit:\(day.string):\(item.id ?? item.title)"
        }
    }

    public var day: DayKey {
        switch self {
        case .create(let day): day
        case .edit(let day, _): day
        }
    }
}
