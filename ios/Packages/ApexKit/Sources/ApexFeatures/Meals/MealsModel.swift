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
    /// The app's write queue once someone is signed in: the composer's saves
    /// wait in its outbox lane (D-052) instead of needing signal. nil sends
    /// direct — a test without one.
    public var writeQueue: WriteQueue?
    public var onMealsChanged: @MainActor @Sendable () async -> Void

    public init(
        client: ApexClient, cache: any CacheStore, clock: any ApexClock = SystemClock(),
        realtime: (any RealtimeChanges)? = nil, timeZone: TimeZone = .current,
        writeQueue: WriteQueue? = nil,
        onMealsChanged: @escaping @MainActor @Sendable () async -> Void = {}
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.realtime = realtime
        self.timeZone = timeZone
        self.writeQueue = writeQueue
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
    /// `.info` for a save that is queued, not yet landed; `.success` otherwise.
    public private(set) var pendingNoticeLevel: Toast.Level = .success
    /// "Saved to library" and friends: the sheet stays open, so the message
    /// is inline text in it, never a toast (a success toast is as hidden
    /// under a sheet as a failure, #167).
    public private(set) var libraryNotice: String?
    public var selectedDay: DayKey
    /// Meals waiting in the outbox lane, counted on every day they touch
    /// (where a meal goes, and where an edit moved it from) — the day's
    /// "waiting to sync" line. The meal itself is listed once the server has
    /// it and the month is re-read; nothing is built locally (D-052). An op
    /// the retry policy gave up on is still waiting (`TrackerOp.isWaiting`).
    public private(set) var pendingMeals: [String: Int] = [:]
    /// Days whose waiting meals include one the lane gave up on: Retry is offered.
    public private(set) var stalledDays: Set<String> = []
    /// The days of every waiting meal op in the lane, by op id: one that is
    /// gone next time has landed, and its days are re-read. A refused op
    /// that goes was let go or replaced — nothing on the server changed.
    private var outboxDays: [Int64: [String]] = [:]

    /// A meal the server refused after it was queued: kept with everything
    /// the composer had, so it can be reopened, fixed and saved again — or
    /// let go. `item` is the queued row read back; `isUpdate` says the save
    /// was an edit of `item.id`, not a new meal.
    public struct RefusedMeal: Identifiable, Sendable, Hashable {
        /// The queued op's id.
        public let id: Int64
        public let day: DayKey
        public let originalDay: DayKey?
        public let item: MealsQueryResult.Item
        public let isUpdate: Bool
        public let reason: String
    }
    /// Refused meals, oldest first.
    public private(set) var refusedMeals: [RefusedMeal] = []

    private var monthsLoaded: Set<String> = []
    private var isStarted = false
    private var realtimeTask: Task<Void, Never>?
    private var outboxTask: Task<Void, Never>?

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
        if let queue = deps.writeQueue {
            // Follow the outbox lane: a meal that lands re-reads its months
            // so it appears; one the server refused is said and let go.
            outboxTask = Task { [weak self] in
                await self?.reloadOutbox()
                for await event in await queue.subscribe() {
                    guard !Task.isCancelled else { return }
                    switch event {
                    case .failed(let session, .meal, let message) where session == .outbox:
                        await self?.mealFailed(message)
                    case .changed(let session) where session == .outbox:
                        await self?.reloadOutbox()
                    default:
                        break
                    }
                }
            }
        }
    }

    public func stop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        outboxTask?.cancel()
        outboxTask = nil
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

    // MARK: - The outbox

    /// Re-counts the lane's meals by day — waiting (pending, or failed only
    /// for want of a server) and refused. A day whose waiting count dropped
    /// has a meal the server now has: its month is re-read, and the schedule
    /// told, the way a direct save does both. A refusal moves a meal from
    /// waiting to `refusedMeals`, where it keeps its content for Fix.
    func reloadOutbox() async {
        guard let queue = deps.writeQueue else { return }
        var pending: [String: Int] = [:]
        var stalled: Set<String> = []
        var refused: [RefusedMeal] = []
        var days: [Int64: [String]] = [:]
        for op in await queue.ops(for: .outbox) {
            guard case .meal(let meal) = op.payload else { continue }
            if op.isWaiting {
                days[op.id] = meal.days
                for day in meal.days { pending[day, default: 0] += 1 }
                if op.gaveUp { stalled.formUnion(meal.days) }
            } else if let item = Self.item(from: meal) {
                refused.append(RefusedMeal(
                    id: op.id, day: DayKey(meal.day) ?? selectedDay, originalDay: meal.originalDay.flatMap { DayKey($0) },
                    item: item, isUpdate: meal.kind == .update, reason: op.lastError ?? "The server did not accept this meal."
                ))
            }
        }
        let landed = Set(outboxDays.filter { id, _ in days[id] == nil && !refused.contains { $0.id == id } }.values.joined()).compactMap { DayKey($0) }
        outboxDays = days
        pendingMeals = pending
        stalledDays = stalled
        refusedMeals = refused
        guard !landed.isEmpty else { return }
        await reload(days: landed)
        await deps.onMealsChanged()
    }

    /// The queued row read back as the item the composer opens on. The
    /// columns are the item's own keys (`MealForm.columns`), so this is a
    /// decode, not a second mapping; an update's columns carry no id, so
    /// the payload's is put in.
    static func item(from meal: MealOpPayload) -> MealsQueryResult.Item? {
        var columns = meal.columns
        columns["id"] = .string(meal.id)
        guard let data = try? JSONEncoder().encode(columns) else { return nil }
        return try? JSONDecoder().decode(MealsQueryResult.Item.self, from: data)
    }

    /// A refusal (4xx) is final and the composer did not catch it — the fat
    /// split, which `MealForm.parse()` leaves to the server, or a meal
    /// deleted elsewhere: said once, and kept in `refusedMeals` for Fix. A
    /// gave-up op is still waiting and says nothing here.
    private func mealFailed(_ message: String) async {
        // Only the op the event names: a refusal is one that is new in
        // `refusedMeals`, not an older one still waiting for Fix.
        let known = Set(refusedMeals.map(\.id))
        await reloadOutbox()
        if refusedMeals.contains(where: { !known.contains($0.id) }) {
            ToastBus.shared.post("A meal wasn't accepted — \(message). Open Meals to fix it.", level: .failure)
        } else {
            ToastBus.shared.post("A meal hasn't synced — the app keeps trying; Retry on its day sends it now.", level: .info)
        }
    }

    /// Let a refused meal go.
    public func deleteRefused(_ id: Int64) async {
        await deps.writeQueue?.discard(id, in: .outbox)
        await reloadOutbox()
    }

    /// The waiting line's Retry: every gave-up op in the lane goes back to
    /// pending and the lane flushes now.
    public func retryOutbox() async {
        await deps.writeQueue?.retryGaveUp(.outbox)
    }

    /// What the queued save said: the meal is here, listed once it syncs.
    public static let queuedNotice = "Saved here — it appears in the day's meals once it syncs."

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
    /// (a missing title, a bad number) or, on the direct path, the server's
    /// (the fat split). With the queue the write waits in the outbox lane
    /// (D-052): the sheet closes at once, the meal is listed once the server
    /// has it, and a refusal the composer did not catch arrives as a toast.
    /// A create's id is minted here, once, so a replay of a save whose
    /// answer was lost is the same meal (`/api/meals` answers it as landed).
    /// `fixing`: the refused op this save replaces — it is let go once the
    /// new one is queued, and a refused create keeps its id.
    public func save(
        _ form: MealForm, editing: MealsQueryResult.Item?, originalDay: DayKey?, fixing: RefusedMeal? = nil
    ) async -> String? {
        guard case .ok(let parsed) = form.parse() else {
            if case .problem(let text) = form.parse() { return text }
            return nil
        }
        if let queue = deps.writeQueue {
            let payload: MealOpPayload
            if let editing, let id = editing.id {
                payload = MealOpPayload(
                    kind: .update, id: id, title: parsed.title, day: form.day.string, originalDay: originalDay?.string,
                    columns: form.fields(parsed: parsed)
                )
            } else {
                let id = fixing?.item.id ?? MealID.mint()
                payload = MealOpPayload(kind: .create, id: id, title: parsed.title, day: form.day.string, columns: form.row(id: id, parsed: parsed))
            }
            do {
                try await queue.enqueue(.meal(payload), for: .outbox)
            } catch {
                return Failure.message(error)
            }
            if let fixing { await queue.discard(fixing.id, in: .outbox) }
            pendingNotice = Self.queuedNotice
            pendingNoticeLevel = .info
            await reloadOutbox()
            // Start the lane now: online it lands in a moment; offline the
            // first try fails on the network and the lane waits for resume.
            Task { await queue.flush(.outbox) }
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
        pendingNoticeLevel = .success
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
        pendingNoticeLevel = .success
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
        ToastBus.shared.post(notice, level: pendingNoticeLevel)
    }
}

/// What the composer opens on: a new meal on a day, one to edit, or a
/// queued save the server refused, reopened from what was queued.
public enum MealComposerRoute: Identifiable, Hashable, Sendable {
    case create(DayKey)
    case edit(day: DayKey, item: MealsQueryResult.Item)
    case fix(MealsModel.RefusedMeal)

    public var id: String {
        switch self {
        case .create(let day): "create:\(day.string)"
        case .edit(let day, let item): "edit:\(day.string):\(item.id ?? item.title)"
        case .fix(let refused): "fix:\(refused.id)"
        }
    }

    public var day: DayKey {
        switch self {
        case .create(let day): day
        case .edit(let day, _): day
        case .fix(let refused): refused.day
        }
    }
}
