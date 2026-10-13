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
    /// Peek-bootstrap today's and tomorrow's workouts after each refresh so the
    /// tracker can start offline (W4). Off in tests that count requests.
    public var prefetchesTracker: Bool

    public init(
        client: ApexClient,
        cache: any CacheStore,
        clock: any ApexClock = SystemClock(),
        streams: (any ActivityStreamsReading)? = nil,
        realtime: (any RealtimeChanges)? = nil,
        timeZone: TimeZone = .current,
        firstWeekday: Int = Calendar.current.firstWeekday,
        prefetchesTracker: Bool = true
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.streams = streams
        self.realtime = realtime
        self.timeZone = timeZone
        self.firstWeekday = firstWeekday
        self.prefetchesTracker = prefetchesTracker
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

    public internal(set) var index: ScheduleIndex?
    public private(set) var fetchedAt: Date?
    public private(set) var lastRefreshFailed = false
    public private(set) var isRefreshing = false
    /// `.sensoryFeedback` trigger (design-spec §9): bumps when a workout is
    /// marked complete from a sheet or a day card; never reset.
    public private(set) var completedCount = 0
    /// Set only when there is nothing cached to show instead.
    public private(set) var loadError: String?
    public private(set) var profile: ProfileResponse?
    public private(set) var mealsByDay: [DayKey: MealsQueryResult.Day] = [:]
    public private(set) var today: DayKey
    /// +1 / −1 for the slide direction of the last `step`; the views animate off it.
    public private(set) var lastStepDirection = 1

    public var mode: Mode = .day
    public var selectedDay: DayKey

    /// Handed every index a refresh brings back from the server. The app
    /// ends a Live Activity whose workout was finished elsewhere through it;
    /// a property rather than a dependency because the activity controller is
    /// built per signed-in user, after this model.
    public var onIndexRefreshed: (@MainActor (ScheduleIndex) async -> Void)?

    let deps: ScheduleDependencies
    private var started = false
    private var pendingRefresh: RefreshReason?
    private var realtimeTask: Task<Void, Never>?
    private var mealsMonthsLoaded: Set<String> = []
    private var streamCache: [String: ActivityStreamRecord?] = [:]
    private var persistTask: Task<Void, Never>?

    /// How long a coalesced cache write waits for the rest of its burst.
    static let persistDebounce: Duration = .milliseconds(400)

    public init(deps: ScheduleDependencies) {
        self.deps = deps
        let today = DayKey.today(clock: deps.clock, timeZone: deps.timeZone)
        self.today = today
        self.selectedDay = today
    }

    // Under MainActor default isolation the deinit would be synthesized as
    // *isolated*, which routes deallocation through swift_task_deinitOnExecutor
    // and aborts on the iOS 17/18 runtime when the object dies outside a task
    // (swiftlang/swift#87316, D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

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
                    case .meals: await self.refreshMeals()
                    default: continue
                    }
                }
            }
        }
    }

    public func stop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        // A debounced write must not outlive the model: a sign-out purges the
        // cache, and a late write would put the outgoing owner's window back.
        persistTask?.cancel()
        persistTask = nil
        if let realtime = deps.realtime {
            Task {
                await realtime.unsubscribe(.schedule)
                await realtime.unsubscribe(.meals)
            }
        }
    }

    private func loadCache() async {
        if let entry = try? await deps.cache.read(kind: .scheduleWindow, key: ScheduleCacheKey.window),
           let cached = try? await Self.buildIndex(from: entry.json) {
            index = await overlayingPendingCompletions(cached)
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
            let built = try await Self.buildIndex(from: data)
            let response = built.response
            let now = deps.clock.now
            index = await overlayingPendingCompletions(built)
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
            if deps.prefetchesTracker { Task { await self.prefetchTrackerBootstraps() } }
            await onIndexRefreshed?(built)
        } catch {
            lastRefreshFailed = true
            let message = Self.readable(error)
            if index == nil {
                // Nothing cached to fall back on: the network line has no
                // "last synced" to speak of.
                loadError = Self.isNetwork(error) ? "No connection. Check your network and retry." : message
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

    /// A toggle made with no signal is in the lane, not on the server: a
    /// window read before it lands would show the occurrence un-flipped. The
    /// pending flips are laid over every window read (cache and network), so
    /// what the user did stays on screen until the server agrees. A single
    /// field on a row the client already has — not a built event (D-008).
    private func overlayingPendingCompletions(_ index: ScheduleIndex) async -> ScheduleIndex {
        guard let queue = writeQueue else { return index }
        var result = index
        for op in await queue.waitingOps(for: .outbox) {
            guard case .completion(let row, _) = op.payload else { continue }
            result = result.settingCompletion(id: row.eventId, isCompleted: row.isCompleted, completedAt: row.completedAt)
        }
        return result
    }

    /// Decode one window and index it away from the main actor.
    ///
    /// `ApexFeatures` is a `defaultIsolation(MainActor)` module, so this whole
    /// parse — 60 days back, 120 forward, plus every definition and template —
    /// used to run on the main actor at launch, on every foreground, on every
    /// realtime echo and after every completion toggle. `Data` in and
    /// `ScheduleIndex` out are both `Sendable`, so only the result comes back.
    private static func buildIndex(from json: Data) async throws -> ScheduleIndex {
        try await Task.detached(priority: .userInitiated) { try ScheduleIndex.decode(json) }.value
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

    /// The cached exercise definitions — the tracker's swap picker reads these
    /// (`search_exercises` carries no ids).
    public func definitions() async -> [ExerciseDefinition] {
        var cached: [ExerciseDefinition] = []
        if let entry = try? await deps.cache.read(kind: .definitions, key: ScheduleCacheKey.definitions),
           let decoded = try? JSONDecoder().decode([ExerciseDefinition].self, from: entry.json) {
            cached = decoded
        }
        // A refresh replaces the cached list with the server's, which does not
        // have an exercise created offline until its queued write lands: keep
        // offering those meanwhile.
        guard let queue = writeQueue else { return cached }
        var known = Set(cached.map(\.id))
        for pending in await queue.pendingDefinitionCreates() {
            guard known.insert(pending.id).inserted else { continue }
            cached.append(ExerciseDefinition(
                id: pending.id, canonicalName: pending.canonicalName, aliases: [], category: pending.category,
                muscleGroups: [], equipment: [], isUnilateral: pending.isUnilateral
            ))
        }
        return cached
    }

    // MARK: - Offline writes (the outbox)

    /// A Builder save the server refused after it was queued offline: kept so
    /// the draft can be reopened, fixed and saved again (or dismissed).
    public struct RefusedSave: Identifiable, Sendable, Equatable {
        /// The queued op's id.
        public let id: Int64
        public let payload: WorkoutDraftOpPayload
        public let reason: String
    }

    /// The app's write queue once someone is signed in (`AppModel` attaches it;
    /// the schedule is built before it). An exercise created or a workout saved
    /// with no signal waits in its outbox lane.
    @ObservationIgnored public private(set) var writeQueue: WriteQueue?
    @ObservationIgnored private var outboxTask: Task<Void, Never>?

    /// Builder saves waiting to sync, counted by the draft's date — the day's
    /// "waiting to sync" line. The workout itself appears once the server has
    /// it: nothing here builds an event or expands a series (D-008).
    public private(set) var pendingSaves: [String: Int] = [:]
    /// Builder saves the server refused, oldest first.
    public private(set) var refusedSaves: [RefusedSave] = []
    /// Completion toggles waiting to sync, by the occurrence's date. The flip
    /// itself is already on the calendar (optimistic); this is the line that
    /// says the server has not heard yet.
    public private(set) var pendingCompletions: [String: Int] = [:]
    /// Meals saved from the composer and waiting to sync, on every day they
    /// touch (`MealOpPayload.days` — the same count the meals model keeps).
    /// The meal appears in the day's list once the server has it (D-052).
    public private(set) var pendingMeals: [String: Int] = [:]
    /// Meals the server refused, by day: fixed or let go from the Meals screen.
    public private(set) var refusedMeals: [String: Int] = [:]
    /// Days with a waiting op the retry policy gave up on (a server that kept
    /// answering 5xx): still waiting, retried on the next resume, and offered
    /// a Retry now. Nothing in the lane is dropped for want of a server.
    public private(set) var stalledDays: Set<String> = []
    /// Every waiting op in the lane that touches the schedule (a save, both
    /// halves of a toggle, an exercise create): what has to drop for the
    /// window to be re-read. Meals are counted apart and re-read their own.
    private var waitingOutboxOps = 0

    /// Attach (or, on sign-out, detach) the queue, and follow its outbox lane:
    /// a refused exercise create is said and dropped (its local copy goes with
    /// a re-read); a refused save is said and kept for Fix; a save that lands
    /// re-reads the schedule so the workout appears.
    public func attach(writeQueue queue: WriteQueue?) {
        outboxTask?.cancel()
        writeQueue = queue
        pendingSaves = [:]
        refusedSaves = []
        pendingCompletions = [:]
        pendingMeals = [:]
        refusedMeals = [:]
        stalledDays = []
        waitingOutboxOps = 0
        guard let queue else { return }
        outboxTask = Task { [weak self] in
            await self?.reloadOutbox()
            for await event in await queue.subscribe() {
                guard !Task.isCancelled else { return }
                switch event {
                case .failed(let session, .createDefinition, let message) where session == .outbox:
                    ToastBus.shared.post("Couldn't add an exercise to your library — \(message)", level: .failure)
                    for op in await queue.ops(for: .outbox) where op.state == .failed {
                        if case .createDefinition = op.payload { await queue.discard(op.id, in: .outbox) }
                    }
                    await self?.refresh(reason: .afterEdit)
                case .failed(let session, .workoutDraft, let message) where session == .outbox:
                    ToastBus.shared.post("A workout saved offline wasn't accepted — \(message). Open its day to fix it.", level: .failure)
                case .failed(let session, .completion, let message) where session == .outbox:
                    await self?.completionFailed(message)
                case .failed(let session, .quickComplete, _) where session == .outbox:
                    // A refusal: the completion stands, the session log did
                    // not follow (the web's fire-and-forget). A gave-up one
                    // is still waiting and says nothing here.
                    for payload in await self?.retireRefused(.quickComplete) ?? [] {
                        guard case .quickComplete(let quick) = payload else { continue }
                        ToastBus.shared.post(Self.planFillFailure(markingComplete: quick.isCompleting), level: .failure)
                    }
                case .changed(let session) where session == .outbox:
                    await self?.reloadOutbox()
                default:
                    break
                }
            }
        }
    }

    /// The lane gave up on, or the server refused, a completion. A refusal
    /// (4xx) is final: the flip is undone here, from the refused row, before
    /// anything is asked of the network — then the server's truth is re-read
    /// on top, and the refused op is let go (its plan-fill went with it in
    /// the queue). A gave-up op is still waiting: it is retried on the next
    /// resume or Retry, and the flip stays.
    private func completionFailed(_ message: String) async {
        let refused = await retireRefused(.completion)
        guard !refused.isEmpty else {
            ToastBus.shared.post("A completion hasn't synced — the app keeps trying; Retry on its day sends it now.", level: .info)
            return
        }
        for payload in refused {
            guard case .completion(let row, _) = payload else { continue }
            index = index?.settingCompletion(id: row.eventId, isCompleted: !row.isCompleted, completedAt: nil)
        }
        ToastBus.shared.post("A completion didn't save — \(message)", level: .failure)
        await persistIndex()
        await refresh(reason: .afterCompletion)
    }

    /// Drops the lane's refused ops of one action (never a gave-up one) and
    /// hands back what they carried, for the toast that names them.
    private func retireRefused(_ action: TrackerAction) async -> [TrackerOpPayload] {
        guard let queue = writeQueue else { return [] }
        var retired: [TrackerOpPayload] = []
        for op in await queue.ops(for: .outbox) where op.isRefused && op.payload.action == action {
            retired.append(op.payload)
            await queue.discard(op.id, in: .outbox)
        }
        return retired
    }

    /// The day line's Retry: every gave-up op in the lane goes back to
    /// pending and the lane flushes now.
    public func retryOutbox() async {
        await writeQueue?.retryGaveUp(.outbox)
    }

    /// Re-reads the outbox: Builder saves, completion toggles and meals
    /// waiting by day, and the refused saves. When an op has left the lane
    /// the schedule is re-read too, so a save or a flip that landed shows as
    /// the server has it.
    func reloadOutbox() async {
        guard let queue = writeQueue else { return }
        var pending: [String: Int] = [:]
        var refused: [RefusedSave] = []
        var completions: [String: Int] = [:]
        var meals: [String: Int] = [:]
        var mealsRefused: [String: Int] = [:]
        var stalled: Set<String> = []
        var waiting = 0
        for op in await queue.ops(for: .outbox) {
            // A gave-up op is still waiting (`TrackerOp.isWaiting`): counted on
            // its day like a pending one, and the day gets Retry.
            let days: [String]
            switch op.payload {
            case .workoutDraft(let save): days = [save.draft.date]
            case .completion(let row, _): days = [row.eventDate]
            case .quickComplete(let quick): days = [quick.eventDate]
            case .meal(let meal): days = meal.days
            default: days = []
            }
            if op.isWaiting, op.gaveUp { stalled.formUnion(days) }
            switch op.payload {
            case .workoutDraft(let save):
                if op.isWaiting {
                    pending[save.draft.date, default: 0] += 1
                    waiting += 1
                } else {
                    refused.append(RefusedSave(id: op.id, payload: save, reason: op.lastError ?? "The server did not accept this workout."))
                }
            case .completion(let row, _) where op.isWaiting:
                completions[row.eventDate, default: 0] += 1
                waiting += 1
            case .meal(let meal):
                for day in meal.days {
                    if op.isWaiting { meals[day, default: 0] += 1 } else { mealsRefused[day, default: 0] += 1 }
                }
            case _ where op.isWaiting:
                waiting += 1
            default:
                break
            }
        }
        let wasWaiting = waitingOutboxOps
        let savesLanded = pendingSaves.values.reduce(0, +) > pending.values.reduce(0, +)
        let mealsLanded = pendingMeals.values.reduce(0, +) > meals.values.reduce(0, +)
        pendingSaves = pending
        refusedSaves = refused
        pendingCompletions = completions
        pendingMeals = meals
        refusedMeals = mealsRefused
        stalledDays = stalled
        waitingOutboxOps = waiting
        // A landed toggle re-reads the window only (as the direct path did);
        // a landed save may have changed meals' days too.
        if waiting < wasWaiting { await refresh(reason: savesLanded ? .afterEdit : .afterCompletion) }
        // The meals model re-reads its own months when a meal lands and
        // tells the schedule through `onMealsChanged`; that hook is wired
        // per sign-in and the queue is shared, so this covers the day row
        // when the meals model was never started.
        if mealsLanded { await refreshMeals() }
    }

    /// The cached workout library — the builder's template search reads this.
    public func templates() async -> [WorkoutTemplate] {
        guard let entry = try? await deps.cache.read(kind: .templates, key: ScheduleCacheKey.templates),
              let decoded = try? JSONDecoder().decode([WorkoutTemplate].self, from: entry.json) else { return [] }
        return decoded
    }
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

    /// Optimistic, and queued. The flip shows at once; `/api/completions` and
    /// the plan-fill (`quick-complete`, the web's fire-and-forget) wait in the
    /// outbox lane behind it, so a toggle made with no signal lands when there
    /// is one (D-052's lane, which never gives up on the network). No rollback
    /// on a transport error — the queue retries; the flip is undone only when
    /// the server refuses the row for good, which arrives as the lane's
    /// `.failed` and re-reads the server's truth (`attach`). The window is
    /// re-read once the writes land. With no queue attached (signed out, a
    /// test without one) the writes go direct, as they did before the lane.
    public func toggleCompletion(_ event: ScheduleEvent) async {
        guard index != nil else { return }
        let target = !event.isCompleted
        // design-spec §9: `.success` on workout completed — the sheet's and the
        // day card's control, not only the tracker's Finish (W13). Fires on the
        // optimistic flip; a rollback is a toast, not a second buzz.
        if target { completedCount += 1 }
        let rows = CompletionRows.build(for: event, isNowCompleted: target, now: deps.clock.now)
        index = index?.settingCompletion(id: event.id, isCompleted: target, completedAt: rows.completionRow.completedAt)
        guard let queue = writeQueue else {
            await sendCompletionDirect(event, target: target, rows: rows)
            return
        }
        let quick = QuickCompletePayload(eventId: event.id, eventDate: event.date, isCompleting: target)
        do {
            try await queue.enqueue(.completion(completionRow: rows.completionRow, logRow: rows.logRow), for: .outbox)
            try await queue.enqueue(.quickComplete(quick), for: .outbox)
        } catch {
            // The store would not take it: nothing will ever send, so undo.
            index = index?.settingCompletion(id: event.id, isCompleted: event.isCompleted, completedAt: event.completedAt)
            ToastBus.shared.post(target ? "Couldn't mark complete — try again" : "Couldn't undo the completion — try again", level: .failure)
            return
        }
        await persistIndex()
        await reloadOutbox()
        // Start the lane now rather than on the next trigger: online, the
        // flip is confirmed in a moment; offline, the first try fails on the
        // network and the lane waits for `resume()`.
        Task { await queue.flush(.outbox) }
    }

    /// The pre-queue path, kept for a model with no queue: `/api/completions`
    /// is authoritative and a failure undoes the flip; the plan-fill is
    /// best-effort and a failure keeps the state and says so.
    private func sendCompletionDirect(_ event: ScheduleEvent, target: Bool, rows: (completionRow: CompletionRow, logRow: CompletionLogRow)) async {
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
            ToastBus.shared.post(Self.planFillFailure(markingComplete: target), level: .failure)
        }
        await persistIndex()
        await refresh(reason: .afterCompletion)
    }

    /// The tracker finished or cancelled a session: flip the calendar here and in
    /// the cache. The authoritative `/api/completions` write rides the tracker's
    /// write queue — the web's injected `setCompletion`, made durable.
    public func applyCompletionLocally(id: String, isCompleted: Bool, completedAt: String?) {
        guard index != nil else { return }
        index = index?.settingCompletion(id: id, isCompleted: isCompleted, completedAt: completedAt)
        schedulePersist()
    }

    // MARK: - Tracker prefetch

    /// `bootstrap { peek: true }` for today's and tomorrow's workouts, so a
    /// tracker opened offline has a server-built model to start from
    /// (architecture.md §7). Quiet, best-effort, and never over a cached session.
    public func prefetchTrackerBootstraps() async {
        for event in [today, today.adding(days: 1)].flatMap({ events(on: $0) }) {
            await prefetchTracker(for: event)
        }
    }

    public func prefetchTracker(for event: ScheduleEvent) async {
        let key = ScheduleCacheKey.trackerBootstrap(eventId: event.id, eventDate: event.date)
        if let entry = try? await deps.cache.read(kind: .trackerBootstrap, key: key) {
            if (try? JSONDecoder().decode(TrackerBootstrap.self, from: entry.json))?.session != nil { return }
            if deps.clock.now.timeIntervalSince(entry.fetchedAt) < CachePolicy.staleAfter { return }
        }
        guard let data = try? await deps.client.data(for: .trackerBootstrap(eventId: event.id, eventDate: event.date, peek: true)),
              (try? JSONDecoder().decode(TrackerBootstrap.self, from: data)) != nil else { return }
        try? await deps.cache.write(CacheEntry(kind: .trackerBootstrap, key: key, json: data, fetchedAt: deps.clock.now))
    }

    /// Write the current window back so an offline relaunch shows the flip.
    /// The encode is the whole window, so it goes to a detached task the same
    /// way the decode does.
    func persistIndex() async {
        guard let index else { return }
        let writtenAt = fetchedAt ?? deps.clock.now
        guard let json = await Task.detached(priority: .utility, operation: { try? index.encodedResponse() }).value else { return }
        try? await deps.cache.write(CacheEntry(
            kind: .scheduleWindow, key: ScheduleCacheKey.window, json: json, fetchedAt: writtenAt
        ))
    }

    /// Debounced: the tracker flips completions in bursts (a finish, then the
    /// calendar echo), and each flip would otherwise re-encode the window. The
    /// first arms a write a beat later; every flip until then rides on it and
    /// the last state wins.
    private func schedulePersist() {
        guard persistTask == nil else { return }
        persistTask = Task { [weak self] in
            try? await Task.sleep(for: Self.persistDebounce)
            guard !Task.isCancelled, let self else { return }
            self.persistTask = nil
            await self.persistIndex()
        }
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

    /// Every month again — realtime, and the meals model after a write (W10).
    public func refreshMeals() async {
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

    static func isNetwork(_ error: Error) -> Bool {
        if let api = error as? APIError, case .network = api { return true }
        return false
    }

    static func readable(_ error: Error) -> String {
        if let api = error as? APIError {
            if case .network = api { return "No connection. Showing what was last synced." }
            return api.description
        }
        return error.localizedDescription
    }

    static func planFillFailure(markingComplete: Bool) -> String {
        markingComplete ? "Marked complete, but the session log didn't save." : "Marked incomplete, but the session log didn't clear."
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
