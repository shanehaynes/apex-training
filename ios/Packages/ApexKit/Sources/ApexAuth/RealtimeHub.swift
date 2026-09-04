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
    private let continuation: AsyncStream<TableGroup>.Continuation
    private let client: SupabaseClient
    private let coalescer: RefreshCoalescer<TableGroup>
    /// Groups something wants, whether or not the scene currently allows them.
    private var wanted: Set<TableGroup> = []
    private var suspended = false
    private var channels: [TableGroup: RealtimeChannelV2] = [:]
    private var listeners: [TableGroup: [Task<Void, Never>]] = [:]

    public init(client: SupabaseClient, clock: any ApexClock = SystemClock(), quietSeconds: Double = 0.25) {
        self.client = client
        self.coalescer = RefreshCoalescer(quiet: quietSeconds, clock: clock)
        (changes, continuation) = AsyncStream.makeStream(of: TableGroup.self)
    }

    public func subscribe(_ group: TableGroup) async {
        wanted.insert(group)
        guard !suspended else { return }
        await join(group)
    }

    public func unsubscribe(_ group: TableGroup) async {
        wanted.remove(group)
        await leave(group)
    }

    /// Scene went to the background: drop the sockets, remember the groups.
    public func suspend() async {
        suspended = true
        for group in channels.keys { await leave(group) }
    }

    /// Scene is active again: rejoin whatever is still wanted.
    public func resume() async {
        suspended = false
        for group in wanted where channels[group] == nil { await join(group) }
    }

    /// Sign-out: nothing is wanted any more.
    public func reset() async {
        wanted = []
        for group in channels.keys { await leave(group) }
    }

    private func join(_ group: TableGroup) async {
        guard channels[group] == nil, let tables = Self.tables[group] else { return }
        let channel = client.channel("apex-ios-\(group.rawValue)")
        // Every binding before the join: registering after `subscribe` is
        // silently ineffective.
        let streams = tables.map { channel.postgresChange(AnyAction.self, schema: "public", table: $0) }
        channels[group] = channel
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
            Self.log.info("realtime joined \(group.rawValue, privacy: .public) (\(tables.count) tables)")
        } catch {
            Self.log.error("realtime join failed for \(group.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
            await leave(group)
        }
    }

    private func leave(_ group: TableGroup) async {
        for task in listeners[group] ?? [] { task.cancel() }
        listeners[group] = nil
        if let channel = channels.removeValue(forKey: group) {
            await client.removeChannel(channel)
        }
    }

    private static let log = Logger(subsystem: "com.shanehaynes.apextraining", category: "realtime")
}
