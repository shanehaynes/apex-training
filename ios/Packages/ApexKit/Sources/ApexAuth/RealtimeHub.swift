import ApexCore
import Foundation
import OSLog
import Supabase

/// Supabase realtime for the whole app (architecture.md §8), one channel per
/// `TableGroup`. Per group, not one channel for everything: the server
/// answers a join with a single verdict for all of its `postgres_changes`
/// bindings, so one table that is not in the publication silently voids every
/// other binding on that channel — which is exactly what a fresh local stack
/// used to do to the schedule. A group is joined only when something renders
/// it; a group that fails to join takes nothing else down and says so in the
/// log.
///
/// A failed join is retried on the write queue's backoff (`RealtimeJoinRetry`
/// over `RetryPolicy`): a cold start with no network yet, or a token still
/// refreshing, used to cost live updates for the whole foreground session,
/// since `wanted` kept the group but nothing re-attempted (#223). When the
/// attempts run out the group lands in `availability`, a persistent state a
/// view can render, and stays there until a later join succeeds.
///
/// Supabase emits one event per changed row, so a bulk edit on the web is a
/// burst; `RefreshCoalescer` turns a burst into one refresh per group (250 ms,
/// the web's `useDebouncedReload`). Channels live while the scene is active
/// (`suspend`/`resume`); the foreground refresh covers what was missed.
///
/// The JWT reaches the socket on its own: `SupabaseClient` forwards every auth
/// event to `realtimeV2.setAuth`, so there is no token plumbing here.
public actor RealtimeHub: RealtimeChanges {
    public static let tables: [TableGroup: [String]] = [
        .schedule: ["workout_events", "recurring_exceptions", "exercise_definitions", "workout_templates", "workout_completions"],
        .blocks: ["training_blocks", "objectives"],
        .meals: ["meals", "meal_favorites"],
        .analytics: ["analytics_tiles"],
    ]

    public nonisolated let changes: AsyncStream<TableGroup>
    /// Every change to "are live updates actually flowing" (#223). Yields on
    /// the transition only, so a view can hold the latest value.
    public nonisolated let availability: AsyncStream<RealtimeAvailability>
    private let continuation: AsyncStream<TableGroup>.Continuation
    private let availabilityContinuation: AsyncStream<RealtimeAvailability>.Continuation
    private let client: SupabaseClient
    private let coalescer: RefreshCoalescer<TableGroup>
    private let clock: any ApexClock
    private let retry: RealtimeJoinRetry
    /// Groups something wants, whether or not the scene currently allows them.
    private var wanted: Set<TableGroup> = []
    private var suspended = false
    private var channels: [TableGroup: RealtimeChannelV2] = [:]
    private var listeners: [TableGroup: [Task<Void, Never>]] = [:]
    /// Bumped by every join and every leave. A join that was left — suspended,
    /// unsubscribed, or superseded — comes back from `subscribeWithError` to a
    /// stale epoch and must touch nothing.
    private var epochs: [TableGroup: Int] = [:]
    /// Joins that have failed since the last success, per group.
    private var failures: [TableGroup: Int] = [:]
    /// The rejoin waiting out a group's backoff: the one a leave, a suspend or
    /// a newer join calls off. Keyed by token because cancelling a sleep ends
    /// it early rather than never, so the task itself re-checks.
    private var waitingRejoin: [TableGroup: UUID] = [:]
    private var rejoinTasks: [UUID: Task<Void, Never>] = [:]
    private var unavailable: Set<TableGroup> = [] {
        didSet {
            guard unavailable != oldValue else { return }
            availabilityContinuation.yield(RealtimeAvailability(unavailable: unavailable))
        }
    }

    public init(
        client: SupabaseClient, clock: any ApexClock = SystemClock(), quietSeconds: Double = 0.25,
        retry: RealtimeJoinRetry = .default
    ) {
        self.client = client
        self.coalescer = RefreshCoalescer(quiet: quietSeconds, clock: clock)
        self.clock = clock
        self.retry = retry
        (changes, continuation) = AsyncStream.makeStream(of: TableGroup.self)
        (availability, availabilityContinuation) = AsyncStream.makeStream(of: RealtimeAvailability.self)
    }

    /// What `availability` last yielded, for a caller that starts observing late.
    public var currentAvailability: RealtimeAvailability { RealtimeAvailability(unavailable: unavailable) }

    public func subscribe(_ group: TableGroup) async {
        wanted.insert(group)
        guard !suspended else { return }
        // Asked for afresh: a new run of attempts, and no stale verdict.
        failures[group] = 0
        unavailable.remove(group)
        await join(group)
    }

    public func unsubscribe(_ group: TableGroup) async {
        wanted.remove(group)
        failures[group] = nil
        unavailable.remove(group)
        await leave(group)
    }

    /// Scene went to the background: drop the sockets, remember the groups.
    public func suspend() async {
        suspended = true
        // A group waiting out its backoff has no channel, so `leave` below
        // would never reach it.
        callOffAllRejoins()
        for group in channels.keys { await leave(group) }
    }

    /// Scene is active again: rejoin whatever is still wanted. The foreground is
    /// a fresh chance, so a group that had given up gets its attempts back —
    /// and a rejoin still waiting out its backoff is called off by `join`
    /// rather than left to fire into a channel that is already up.
    public func resume() async {
        suspended = false
        for group in wanted where channels[group] == nil {
            failures[group] = 0
            unavailable.remove(group)
            await join(group)
        }
    }

    /// Sign-out: nothing is wanted any more.
    public func reset() async {
        wanted = []
        failures = [:]
        unavailable = []
        callOffAllRejoins()
        for group in channels.keys { await leave(group) }
    }

    private func join(_ group: TableGroup) async {
        // Whatever brought us here supersedes a rejoin that has not fired.
        callOffRejoin(for: group)
        guard channels[group] == nil, let tables = Self.tables[group] else { return }
        let channel = client.channel("apex-ios-\(group.rawValue)")
        // Every binding before the join: registering after `subscribe` is
        // silently ineffective.
        let streams = tables.map { channel.postgresChange(AnyAction.self, schema: "public", table: $0) }
        channels[group] = channel
        let epoch = bumpEpoch(group)
        listeners[group] = streams.map { stream in
            Task { [coalescer, continuation] in
                for await _ in stream {
                    if Task.isCancelled { return }
                    if await coalescer.request(group) { continuation.yield(group) }
                }
            }
        }
        do {
            // Not the deprecated `subscribe()`: it swallows the error, and a
            // channel that never joined looks exactly like a quiet one.
            try await channel.subscribeWithError()
            guard epochs[group] == epoch else { return }
            failures[group] = 0
            unavailable.remove(group)
            Self.log.info("realtime joined \(group.rawValue, privacy: .public) (\(tables.count) tables)")
        } catch {
            Self.log.error("realtime join failed for \(group.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
            guard epochs[group] == epoch else { return }
            await leave(group)
            scheduleRejoin(group)
        }
    }

    /// One more failure for the group: wait out the backoff and try again, or —
    /// out of attempts — say live updates are unavailable and stop.
    private func scheduleRejoin(_ group: TableGroup) {
        guard !suspended, wanted.contains(group) else { return }
        let failed = (failures[group] ?? 0) + 1
        failures[group] = failed
        switch retry.step(afterFailures: failed) {
        case .giveUp:
            Self.log.error("realtime unavailable for \(group.rawValue, privacy: .public) after \(failed, privacy: .public) attempts")
            unavailable.insert(group)
        case .retry(let delay):
            let token = UUID()
            waitingRejoin[group] = token
            rejoinTasks[token] = Task { [weak self, clock] in
                try? await clock.sleep(seconds: delay)
                await self?.rejoinFired(group, token: token)
            }
        }
    }

    /// Cancels a group's waiting rejoin. The task stays in `rejoinTasks` until
    /// it winds down, so `awaitRejoins` cannot return while one is in flight.
    private func callOffRejoin(for group: TableGroup) {
        guard let token = waitingRejoin.removeValue(forKey: group) else { return }
        rejoinTasks[token]?.cancel()
    }

    private func callOffAllRejoins() {
        for group in Array(waitingRejoin.keys) { callOffRejoin(for: group) }
    }

    private func rejoinFired(_ group: TableGroup, token: UUID) async {
        defer { rejoinTasks[token] = nil }
        // Called off while it waited (a suspend, a leave, or a join that has
        // already put the channel up): cancelling a sleep ends it early rather
        // than never, so this is where the rejoin stops.
        guard waitingRejoin[group] == token else { return }
        waitingRejoin[group] = nil
        guard !suspended, wanted.contains(group), channels[group] == nil else { return }
        await join(group)
    }

    /// For tests and the driver: wait for every scheduled rejoin to have fired
    /// or wound down, including the ones those rejoins scheduled in turn.
    public func awaitRejoins() async {
        while let task = rejoinTasks.values.first {
            await task.value
        }
    }

    private func bumpEpoch(_ group: TableGroup) -> Int {
        let next = (epochs[group] ?? 0) + 1
        epochs[group] = next
        return next
    }

    private func leave(_ group: TableGroup) async {
        callOffRejoin(for: group)
        // Anything still joining for this group is now stale.
        _ = bumpEpoch(group)
        for task in listeners[group] ?? [] { task.cancel() }
        listeners[group] = nil
        if let channel = channels.removeValue(forKey: group) {
            await client.removeChannel(channel)
        }
    }

    private static let log = Logger(subsystem: "com.shanehaynes.apextraining", category: "realtime")
}
