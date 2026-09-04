import ApexCore
import ApexUI
import Foundation
import Observation

/// Everything the Schedule screens read through, injected so the model runs
/// against fakes in `ApexTests` and against fixtures under `-apexMockClient`.
public struct ScheduleDependencies: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var clock: any ApexClock
    public var streams: (any ActivityStreamsReading)?
    public var realtime: (any RealtimeChanges)?
    public var timeZone: TimeZone
    /// `Calendar` convention: 1 = Sunday, 2 = Monday.
    public var firstWeekday: Int

    public init(
        client: ApexClient,
        cache: any CacheStore,
        clock: any ApexClock = SystemClock(),
        streams: (any ActivityStreamsReading)? = nil,
        realtime: (any RealtimeChanges)? = nil,
        timeZone: TimeZone = .current,
        firstWeekday: Int = Calendar.current.firstWeekday
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.streams = streams
        self.realtime = realtime
        self.timeZone = timeZone
        self.firstWeekday = firstWeekday
    }
}

/// The Schedule tab's state (D-006): one window of schedule, stale-while-
/// revalidate over the cache, an optimistic completion toggle, and the meals
/// summary per month. Rendering reads; the network writes; nothing in here
/// expands recurrence or sums macros — the server did (D-008).
@MainActor
@Observable
public final class ScheduleModel {
    public typealias Mode = ScheduleMode
    public typealias RefreshReason = ScheduleRefreshReason

    public private(set) var index: ScheduleIndex?
    public private(set) var fetchedAt: Date?
    public private(set) var lastRefreshFailed = false
    public private(set) var isRefreshing = false
    /// Set only when there is nothing cached to show instead.
    public private(set) var loadError: String?
    public private(set) var profile: ProfileResponse?
    public private(set) var mealsByDay: [DayKey: MealsQueryResult.Day] = [:]
    public private(set) var today: DayKey
    /// +1 / −1 for the slide direction of the last `step`; the views animate off it.
    public private(set) var lastStepDirection = 1

    public var mode: Mode = .day
    public var selectedDay: DayKey

    private let deps: ScheduleDependencies
    private var started = false
    private var pendingRefresh: RefreshReason?
    private var realtimeTask: Task<Void, Never>?
    private var mealsMonthsLoaded: Set<String> = []
    private var streamCache: [String: ActivityStreamRecord?] = [:]

    public init(deps: ScheduleDependencies) {
        self.deps = deps
        let today = DayKey.today(clock: deps.clock, timeZone: deps.timeZone)
        self.today = today
        self.selectedDay = today
    }

    // MARK: - Lifecycle

    /// Cache first, then the network, then realtime. Idempotent: the tab's
    /// `.task` calls it every time the tab appears.
    public func start() async {
        guard !started else { return }
        started = true
        await loadCache()
        await refresh(reason: .launch)
        await loadMeals(for: selectedDay)
        Task { await self.loadProfile() }
        if let realtime = deps.realtime {
            // The scene is already active when the user signs in, so nobody
            // else would subscribe until the app is next backgrounded.
            await realtime.subscribe(.schedule)
            await realtime.subscribe(.meals)
            realtimeTask = Task { [weak self] in
                for await group in realtime.changes {
                    guard let self, !Task.isCancelled else { return }
                    switch group {
                    case .schedule: await self.refresh(reason: .realtime)
                    case .meals: await self.reloadMeals()
                    default: continue
                    }
                }
            }
        }
    }

    public func stop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        if let realtime = deps.realtime {
            Task {
                await realtime.unsubscribe(.schedule)
                await realtime.unsubscribe(.meals)
            }
        }
    }

    private func loadCache() async {
        if let entry = try? await deps.cache.read(kind: .scheduleWindow, key: ScheduleCacheKey.window),
           let response = try? JSONDecoder().decode(ScheduleResponse.self, from: entry.json) {
            index = ScheduleIndex(response)
            fetchedAt = entry.fetchedAt
        }
        if let entry = try? await deps.cache.read(kind: .profile, key: ScheduleCacheKey.profile),
           let cached = try? JSONDecoder().decode(ProfileResponse.self, from: entry.json) {
            profile = cached
        }
    }

    /// One in flight at a time; a request that arrives mid-flight runs once
    /// more afterwards rather than in parallel (the window is one key).
    public func refresh(reason: RefreshReason) async {
        if isRefreshing {
            pendingRefresh = reason
            return
        }
        isRefreshing = true
        today = DayKey.today(clock: deps.clock, timeZone: deps.timeZone)
        let window = ScheduleWindow.around(today)
        do {
            let data = try await deps.client.data(
                for: .schedule(start: window.start.string, end: window.end.string, include: ["definitions", "templates"])
            )
            let response = try JSONDecoder().decode(ScheduleResponse.self, from: data)
            let now = deps.clock.now
            index = ScheduleIndex(response)
            fetchedAt = now
            lastRefreshFailed = false
            loadError = nil
            try? await deps.cache.write(CacheEntry(kind: .scheduleWindow, key: ScheduleCacheKey.window, json: data, fetchedAt: now))
            if let definitions = response.definitions, let json = try? JSONEncoder().encode(definitions) {
                try? await deps.cache.write(CacheEntry(kind: .definitions, key: ScheduleCacheKey.definitions, json: json, fetchedAt: now))
            }
            if let templates = response.templates, let json = try? JSONEncoder().encode(templates) {
                try? await deps.cache.write(CacheEntry(kind: .templates, key: ScheduleCacheKey.templates, json: json, fetchedAt: now))
            }
        } catch {
            lastRefreshFailed = true
            let message = Self.readable(error)
            if index == nil {
                loadError = message
            } else if reason == .pullToRefresh || reason == .retry {
                ToastBus.shared.post(message, level: .failure)
            }
        }
        isRefreshing = false
        if reason != .launch, reason != .afterCompletion {
            // Anything that re-read the schedule may have changed meals too.
            mealsMonthsLoaded.removeAll()
            await loadMeals(for: selectedDay)
        }
        if let next = pendingRefresh {
            pendingRefresh = nil
            await refresh(reason: next)
        }
    }

    private func loadProfile() async {
        guard let data = try? await deps.client.data(for: .profile),
              let decoded = try? JSONDecoder().decode(ProfileResponse.self, from: data) else { return }
        profile = decoded
        try? await deps.cache.write(CacheEntry(kind: .profile, key: ScheduleCacheKey.profile, json: data, fetchedAt: deps.clock.now))
    }

    // MARK: - Reads

    public func events(on day: DayKey) -> [ScheduleEvent] { index?.events(on: day) ?? [] }
    public func event(id: String) -> ScheduleEvent? { index?.event(id: id) }
    public func typeDots(on day: DayKey) -> [WorkoutType] { index?.typeDots(on: day) ?? [] }
    public func meals(on day: DayKey) -> MealsQueryResult.Day? { mealsByDay[day] }

    public var firstWeekday: Int { deps.firstWeekday }
    public var visibleMonth: (year: Int, month: Int) { (selectedDay.year, selectedDay.month) }

    /// The stale / past-the-horizon line, or nil when the cache is trustworthy.
    public var freshnessLabel: String? {
        if let label = StaleAffordance.label(fetchedAt: fetchedAt, now: deps.clock.now, lastRefreshFailed: lastRefreshFailed) {
            return label
        }
        guard let horizon = index?.horizon else { return nil }
        let showing: DayKey = mode == .day ? selectedDay : selectedDay.monthStart
        return StaleAffordance.horizonLabel(showing: showing, horizon: horizon)
    }

    public var periodTitle: String {
        switch mode {
        case .day:
            return "\(MonthNames.weekdayShort[selectedDay.weekday - 1]), \(MonthNames.short[selectedDay.month - 1]) \(selectedDay.day)"
        case .month:
            return MonthGrid.title(year: selectedDay.year, month: selectedDay.month)
        }
    }

    public var isShowingToday: Bool {
        switch mode {
        case .day: selectedDay == today
        case .month: selectedDay.year == today.year && selectedDay.month == today.month
        }
    }

    // MARK: - Navigation

    public func goToToday() {
        lastStepDirection = selectedDay < today ? 1 : -1
        selectedDay = today
    }

    public func step(_ delta: Int) {
        lastStepDirection = delta >= 0 ? 1 : -1
        switch mode {
        case .day:
            selectedDay = selectedDay.adding(days: delta)
        case .month:
            let next = MonthGrid.step(year: selectedDay.year, month: selectedDay.month, by: delta)
            let day = min(selectedDay.day, DayKey.daysInMonth(year: next.year, month: next.month))
            selectedDay = DayKey(year: next.year, month: next.month, day: day)
        }
    }

    public func select(_ day: DayKey) {
        lastStepDirection = day < selectedDay ? -1 : 1
        selectedDay = day
    }

    // MARK: - Completion

    /// Optimistic. `/api/completions` is the authoritative row: if it fails the
    /// flip is undone. The plan-fill (`quick-complete`) is best-effort, like the
    /// web's fire-and-forget: a failure keeps the state and says so.
    public func toggleCompletion(_ event: ScheduleEvent) async {
        guard index != nil else { return }
        let target = !event.isCompleted
        let rows = CompletionRows.build(for: event, isNowCompleted: target, now: deps.clock.now)
        index = index?.settingCompletion(id: event.id, isCompleted: target, completedAt: rows.completionRow.completedAt)
        do {
            _ = try await deps.client.data(for: .completions(completionRow: rows.completionRow, logRow: rows.logRow))
        } catch {
            index = index?.settingCompletion(id: event.id, isCompleted: event.isCompleted, completedAt: event.completedAt)
            ToastBus.shared.post(Self.completionFailure(error, markingComplete: target), level: .failure)
            return
        }
        do {
            _ = try await deps.client.data(for: .workoutSessions(
                action: target ? "quick-complete" : "quick-uncomplete", eventId: event.id, eventDate: event.date
            ))
        } catch {
            ToastBus.shared.post(
                target ? "Marked complete, but the session log didn't save." : "Marked incomplete, but the session log didn't clear.",
                level: .failure
            )
        }
        await persistIndex()
        await refresh(reason: .afterCompletion)
    }

    /// Write the current window back so an offline relaunch shows the flip.
    private func persistIndex() async {
        guard let index, let json = try? JSONEncoder().encode(index.response) else { return }
        try? await deps.cache.write(CacheEntry(
            kind: .scheduleWindow, key: ScheduleCacheKey.window, json: json, fetchedAt: fetchedAt ?? deps.clock.now
        ))
    }

    // MARK: - Meals

    public func loadMeals(for day: DayKey) async {
        let key = ScheduleCacheKey.meals(year: day.year, month: day.month)
        guard !mealsMonthsLoaded.contains(key) else { return }
        mealsMonthsLoaded.insert(key)
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
            // A month with no meals has no days; clear what an older cache said.
            for (k, _) in mealsByDay where k.year == day.year && k.month == day.month { mealsByDay[k] = nil }
            apply(envelope.result)
            try? await deps.cache.write(CacheEntry(kind: .mealsWindow, key: key, json: data, fetchedAt: deps.clock.now))
        } catch {
            // Silent: the row shows "No meals logged" and the next refresh retries.
            mealsMonthsLoaded.remove(key)
        }
    }

    private func reloadMeals() async {
        mealsMonthsLoaded.removeAll()
        await loadMeals(for: selectedDay)
    }

    private func apply(_ result: MealsQueryResult) {
        for day in result.days {
            if let key = DayKey(day.date) { mealsByDay[key] = day }
        }
    }

    // MARK: - Streams

    /// Memoised per occurrence; nil is the normal answer and is cached too.
    public func streams(for event: ScheduleEvent) async -> ActivityStreamRecord? {
        if let cached = streamCache[event.id] { return cached }
        guard let reader = deps.streams else { return nil }
        let record = try? await reader.record(eventId: event.id, eventDate: event.date)
        streamCache[event.id] = .some(record)
        return record
    }

    // MARK: - Messages

    static func readable(_ error: Error) -> String {
        if let api = error as? APIError {
            if case .network = api { return "No connection. Showing what was last synced." }
            return api.description
        }
        return error.localizedDescription
    }

    static func completionFailure(_ error: Error, markingComplete: Bool) -> String {
        if let api = error as? APIError, case .network = api {
            return markingComplete
                ? "No connection — couldn't mark complete. Try again when you're back online."
                : "No connection — couldn't undo the completion. Try again when you're back online."
        }
        return Self.readable(error)
    }
}
