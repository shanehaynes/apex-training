import ApexCore
import ApexUI
import Foundation
import Observation

/// Everything the Analytics screens read through, injected so the model runs
/// against fakes in `ApexTests` and against fixtures under `-apexMockClient`.
public struct AnalyticsDependencies: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var clock: any ApexClock
    public var realtime: (any RealtimeChanges)?
    public var timeZone: TimeZone

    public init(
        client: ApexClient,
        cache: any CacheStore,
        clock: any ApexClock = SystemClock(),
        realtime: (any RealtimeChanges)? = nil,
        timeZone: TimeZone = .current
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.realtime = realtime
        self.timeZone = timeZone
    }
}

/// What the Analytics tab presents over the dashboard.
public enum AnalyticsSheet: Identifiable, Equatable, Sendable {
    /// The tile builder: a new tile, or an existing one to edit.
    case builder(tile: AnalyticsTile?)

    public var id: String {
        switch self {
        case .builder(let tile): tile?.id ?? "new"
        }
    }
}

/// The Analytics tab's state (W9): the saved tiles, one computed result per
/// tile, stale-while-revalidate over the cache, an edit mode that reorders
/// and sizes (D-011), and the kebab's duplicate and delete — all optimistic
/// with a rollback, the schedule's pattern (D-027). Rendering reads; the
/// server computes every number (D-008).
@MainActor
@Observable
public final class AnalyticsModel {
    public typealias RefreshReason = AnalyticsRefreshReason

    /// In dashboard order (`y`, then `x`).
    public private(set) var tiles: [AnalyticsTile] = []
    public private(set) var results: [String: TileResult] = [:]
    public private(set) var options = TileOptions.empty
    public private(set) var fetchedAt: Date?
    public private(set) var lastRefreshFailed = false
    public private(set) var isRefreshing = false
    public private(set) var isComputing = false
    /// Set only when there is nothing cached to show instead.
    public private(set) var loadError: String?
    /// Whether any read (cache or network) has answered — an empty dashboard
    /// is only "no tiles yet" once something has.
    public private(set) var hasLoaded = false
    public private(set) var today: DayKey

    // Edit mode (D-011).
    public private(set) var isEditing = false
    public var editOrder: [String] = []
    public var editHeights: [String: TileHeight] = [:]

    public var sheet: AnalyticsSheet?

    let deps: AnalyticsDependencies
    private var started = false
    private var pendingRefresh: RefreshReason?
    private var realtimeTask: Task<Void, Never>?

    public init(deps: AnalyticsDependencies) {
        self.deps = deps
        self.today = DayKey.today(clock: deps.clock, timeZone: deps.timeZone)
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
        if let realtime = deps.realtime {
            await realtime.subscribe(.analytics)
            realtimeTask = Task { [weak self] in
                for await group in realtime.changes {
                    guard let self, !Task.isCancelled else { return }
                    if group == .analytics { await self.refresh(reason: .realtime) }
                }
            }
        }
    }

    public func stop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        if let realtime = deps.realtime {
            Task { await realtime.unsubscribe(.analytics) }
        }
    }

    private func loadCache() async {
        guard let entry = try? await deps.cache.read(kind: .analyticsTiles, key: AnalyticsCacheKey.tiles),
              let response = try? JSONDecoder().decode(AnalyticsTilesResponse.self, from: entry.json) else { return }
        tiles = TileLayoutPlan.ordered(response.tiles)
        options = response.options
        fetchedAt = entry.fetchedAt
        hasLoaded = true
        // A cached result is shown only when it was computed from the spec the
        // tile still has, on the day it is; anything else waits for compute.
        let day = today.string
        for tile in tiles {
            if let cached = await cachedResult(for: tile), cached.matches(spec: tile.spec, today: day) {
                results[tile.id] = cached.result
            }
        }
    }

    private func cachedResult(for tile: AnalyticsTile) async -> CachedTileResult? {
        guard let entry = try? await deps.cache.read(kind: .analyticsResult, key: AnalyticsCacheKey.result(tileId: tile.id)) else { return nil }
        return try? JSONDecoder().decode(CachedTileResult.self, from: entry.json)
    }

    /// One in flight at a time; a request that arrives mid-flight runs once
    /// more afterwards rather than in parallel.
    public func refresh(reason: RefreshReason) async {
        if isRefreshing {
            pendingRefresh = reason
            return
        }
        isRefreshing = true
        today = DayKey.today(clock: deps.clock, timeZone: deps.timeZone)
        do {
            let data = try await deps.client.data(for: .analyticsTiles)
            let response = try JSONDecoder().decode(AnalyticsTilesResponse.self, from: data)
            let now = deps.clock.now
            tiles = TileLayoutPlan.ordered(response.tiles)
            options = response.options
            fetchedAt = now
            lastRefreshFailed = false
            loadError = nil
            hasLoaded = true
            try? await deps.cache.write(CacheEntry(kind: .analyticsTiles, key: AnalyticsCacheKey.tiles, json: data, fetchedAt: now))
            await compute(reason: reason)
        } catch {
            lastRefreshFailed = true
            if !hasLoaded {
                loadError = Self.isNetwork(error) ? "No connection. Check your network and retry." : Self.readable(error)
            } else if reason.isUserInitiated {
                ToastBus.shared.post(Self.readable(error), level: .failure)
            }
        }
        isRefreshing = false
        if let next = pendingRefresh {
            pendingRefresh = nil
            await refresh(reason: next)
        }
    }

    /// One request for every tile that needs computing, in chunks of 24;
    /// results land index-aligned and each is cached with what it was
    /// computed from. A tile whose stored spec no longer validates never
    /// hits the network — its card explains itself.
    private func compute(reason: RefreshReason) async {
        let day = today.string
        var pending: [AnalyticsTile] = []
        for tile in tiles where tile.spec != nil {
            if reason.trustsCache, results[tile.id] != nil { continue }
            if reason.trustsCache, let cached = await cachedResult(for: tile), cached.matches(spec: tile.spec, today: day) {
                results[tile.id] = cached.result
                continue
            }
            pending.append(tile)
        }
        // Tiles that left the dashboard leave their results behind.
        let live = Set(tiles.map(\.id))
        results = results.filter { live.contains($0.key) }
        guard !pending.isEmpty else { return }
        isComputing = true
        defer { isComputing = false }
        let chunks = stride(from: 0, to: pending.count, by: Self.maxSpecsPerRequest).map {
            Array(pending[$0..<min($0 + Self.maxSpecsPerRequest, pending.count)])
        }
        for chunk in chunks {
            do {
                let data = try await deps.client.data(for: .analyticsCompute(specs: chunk.compactMap(\.spec), today: day))
                let response = try JSONDecoder().decode(AnalyticsComputeResponse.self, from: data)
                for (tile, result) in zip(chunk, response.tiles) {
                    results[tile.id] = result
                    if let spec = tile.spec, let json = try? JSONEncoder().encode(CachedTileResult(spec: spec, today: day, result: result)) {
                        try? await deps.cache.write(CacheEntry(kind: .analyticsResult, key: AnalyticsCacheKey.result(tileId: tile.id), json: json, fetchedAt: deps.clock.now))
                    }
                }
            } catch {
                lastRefreshFailed = true
                if reason.isUserInitiated { ToastBus.shared.post(Self.readable(error), level: .failure) }
                return
            }
        }
    }

    /// `MAX_SPECS` on the server.
    static let maxSpecsPerRequest = 24

    // MARK: - Reads

    public func tile(id: String) -> AnalyticsTile? { tiles.first { $0.id == id } }
    public func result(for tile: AnalyticsTile) -> TileResult? { results[tile.id] }

    /// The stale line, or nil when the cache is trustworthy.
    public var freshnessLabel: String? {
        StaleAffordance.label(fetchedAt: fetchedAt, now: deps.clock.now, lastRefreshFailed: lastRefreshFailed)
    }

    // MARK: - Edit mode (D-011)

    public func beginEdit() {
        editOrder = tiles.map(\.id)
        editHeights = Dictionary(uniqueKeysWithValues: tiles.map { ($0.id, TileHeight.nearest(h: $0.layout.h)) })
        isEditing = true
    }

    public func move(from source: IndexSet, to destination: Int) {
        editOrder.move(fromOffsets: source, toOffset: destination)
    }

    public func setHeight(_ id: String, _ height: TileHeight) {
        editHeights[id] = height
    }

    public func cancelEdit() {
        isEditing = false
    }

    /// The order and heights as the user left them → full-width rows
    /// (`TileLayoutPlan`); only the rows that changed are written. Optimistic:
    /// the dashboard shows the new layout at once and reverts on failure.
    @discardableResult
    public func commitEdit() async -> Bool {
        let order = editOrder.compactMap { id in tiles.first { $0.id == id } }
        let plan = TileLayoutPlan.layouts(order: order, heights: editHeights)
        let changed = TileLayoutPlan.changed(plan, from: tiles)
        isEditing = false
        guard !changed.isEmpty else { return true }
        let before = tiles
        var byId = Dictionary(uniqueKeysWithValues: tiles.map { ($0.id, $0) })
        for update in plan { byId[update.id]?.layout = update.layout }
        tiles = TileLayoutPlan.ordered(order.compactMap { byId[$0.id] })
        do {
            _ = try await deps.client.data(for: .saveLayouts(changed))
        } catch {
            tiles = before
            ToastBus.shared.post(Self.isNetwork(error) ? "No connection — couldn't save the layout." : "Couldn't save the layout — try again", level: .failure)
            return false
        }
        await persistTiles()
        return true
    }

    // MARK: - Kebab

    /// The web's duplicate: the same draft titled "(copy)", full width at the
    /// bottom, the source's result reused (same spec, same numbers).
    public func duplicate(_ tile: AnalyticsTile) async {
        guard var draft = tile.draft else { return }
        draft.title = "\(tile.title) (copy)"
        let id = TileID.mint()
        let layout = TileLayoutPlan.nextLayout(after: tiles, height: TileHeight.nearest(h: tile.layout.h))
        var spec = tile.spec
        if case .object(var object) = spec {
            object["title"] = .string(draft.title)
            spec = .object(object)
        }
        let copy = AnalyticsTile(id: id, title: draft.title, spec: spec, draft: draft, layout: layout)
        let before = tiles
        tiles.append(copy)
        results[id] = results[tile.id]
        do {
            let data = try await deps.client.data(for: .saveTile(id: id, draft: draft, layout: layout))
            let response = try JSONDecoder().decode(TileSaveResponse.self, from: data)
            guard response.ok else {
                tiles = before
                results[id] = nil
                ToastBus.shared.post(response.problem ?? "Couldn't duplicate the tile", level: .failure)
                return
            }
            if let saved = response.tile, let index = tiles.firstIndex(where: { $0.id == id }) {
                tiles[index] = saved
            }
        } catch {
            tiles = before
            results[id] = nil
            ToastBus.shared.post(Self.isNetwork(error) ? "No connection — couldn't duplicate the tile." : "Couldn't duplicate the tile — try again", level: .failure)
            return
        }
        await persistTiles()
    }

    /// Optimistic removal; a 404 means it was already gone and stays gone.
    public func delete(_ tile: AnalyticsTile) async {
        let before = tiles
        let result = results[tile.id]
        tiles.removeAll { $0.id == tile.id }
        results[tile.id] = nil
        do {
            _ = try await deps.client.data(for: .deleteTile(id: tile.id))
        } catch let error as APIError {
            if case .server(let status, _) = error, status == 404 {
                // Already deleted elsewhere — the removal stands.
            } else {
                tiles = before
                results[tile.id] = result
                ToastBus.shared.post(Self.isNetwork(error) ? "No connection — couldn't delete the tile." : "Couldn't delete the tile — try again", level: .failure)
                return
            }
        } catch {
            tiles = before
            results[tile.id] = result
            ToastBus.shared.post("Couldn't delete the tile — try again", level: .failure)
            return
        }
        try? await deps.cache.purge(kind: .analyticsResult)
        await persistTiles()
    }

    /// The builder saved a tile: show it (with the preview's result when the
    /// builder has one), then refresh — the numbers may have moved.
    public func saved(_ tile: AnalyticsTile, result: TileResult?) async {
        if let index = tiles.firstIndex(where: { $0.id == tile.id }) {
            tiles[index] = tile
        } else {
            tiles.append(tile)
        }
        tiles = TileLayoutPlan.ordered(tiles)
        if let result {
            results[tile.id] = result
        } else {
            results[tile.id] = nil
        }
        await persistTiles()
        await refresh(reason: .afterSave)
    }

    /// Write the current tiles back under the existing `fetchedAt`, so an
    /// optimistic edit does not look freshly synced.
    private func persistTiles() async {
        guard let fetchedAt,
              let json = try? JSONEncoder().encode(AnalyticsTilesResponse(tiles: tiles, options: options)) else { return }
        try? await deps.cache.write(CacheEntry(kind: .analyticsTiles, key: AnalyticsCacheKey.tiles, json: json, fetchedAt: fetchedAt))
    }

    // MARK: - Errors

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
}
