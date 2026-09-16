import ApexCore
import ApexUI
import Foundation
import Observation

/// What the Blocks screens need (W10): the client, the cache, the clock and
/// zone `today` comes from, and the realtime hub for the `blocks` group.
public struct BlocksDependencies: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var clock: any ApexClock
    public var realtime: (any RealtimeChanges)?
    public var timeZone: TimeZone

    public init(
        client: ApexClient, cache: any CacheStore, clock: any ApexClock = SystemClock(),
        realtime: (any RealtimeChanges)? = nil, timeZone: TimeZone = .current
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.realtime = realtime
        self.timeZone = timeZone
    }
}

/// Training blocks and objectives (`BlocksView.tsx`, `BlockDetail.tsx`,
/// `BlockEditor.tsx`, `CycleEditor.tsx`): the list and every objective from
/// one `get_training_blocks` read, a block's progress by `block_id`, the
/// editor's writes, and the cycle generator's server-side preview. Nothing
/// about weeks, attainment or cadence is computed here (D-033): the server
/// sends `weeks` and `current_week`, the attainment rows, and the dated
/// cycle — `today` travels on every read so they agree with the phone.
@MainActor
@Observable
public final class BlocksModel {
    public let deps: BlocksDependencies

    public private(set) var blocks: [BlockSummary] = []
    public private(set) var objectives: [Objective] = []
    /// The block covering today, if any.
    public private(set) var current: BlockSummary?
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// The first load failed and nothing is cached: the root shows a retry.
    public private(set) var loadError: String?
    /// Progress by block id, computed for `today`.
    public private(set) var progress: [String: BlockProgress] = [:]
    public private(set) var progressFailed: Set<String> = []
    /// A success message for the screen under a closing sheet to toast.
    public private(set) var pendingNotice: String?

    public enum PreviewState: Sendable, Equatable {
        case idle
        case loading
        case ready(CyclePreviewResponse)
        case problem(String)
        case failed(String)
    }
    public private(set) var preview: PreviewState = .idle
    /// The debounce between an edit and its preview; zero in tests.
    public var previewDelay: Duration = .milliseconds(300)

    private var isStarted = false
    private var realtimeTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var generation = 0
    /// A write happened: cached progress is stale until re-read.
    private var progressStale = false

    public init(deps: BlocksDependencies) {
        self.deps = deps
    }

    // Under MainActor default isolation the deinit would be synthesized as
    // *isolated*, which routes deallocation through swift_task_deinitOnExecutor
    // and aborts on the iOS 17/18 runtime when the object dies outside a task
    // (swiftlang/swift#87316, D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

    public var today: DayKey { DayKey.today(clock: deps.clock, timeZone: deps.timeZone) }

    // MARK: - Lifecycle

    /// Cache first, then the network, then realtime. Idempotent.
    public func start() async {
        guard !isStarted else { return }
        isStarted = true
        isLoading = true
        if let entry = try? await deps.cache.read(kind: .blocks, key: ScheduleCacheKey.blocks),
           let cached = try? JSONDecoder().decode(TrainingBlocksQueryResult.self, from: entry.json) {
            apply(cached)
        }
        await refresh()
        isLoading = false
        if let realtime = deps.realtime {
            await realtime.subscribe(.blocks)
            realtimeTask = Task { [weak self] in
                for await group in realtime.changes {
                    guard let self, !Task.isCancelled else { return }
                    if group == .blocks {
                        self.progressStale = true
                        await self.refresh()
                    }
                }
            }
        }
    }

    public func stop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        previewTask?.cancel()
        previewTask = nil
        if let realtime = deps.realtime {
            Task { await realtime.unsubscribe(.blocks) }
        }
    }

    /// The list read: every block and objective, no progress.
    public func refresh() async {
        do {
            let envelope = try await deps.client.send(
                .query(tool: "get_training_blocks", args: TrainingBlocksQueryResult.args(today: today.string)),
                as: QueryEnvelope<TrainingBlocksQueryResult>.self
            )
            apply(envelope.result)
            loadError = nil
            if let json = try? JSONEncoder().encode(envelope.result) {
                try? await deps.cache.write(CacheEntry(kind: .blocks, key: ScheduleCacheKey.blocks, json: json, fetchedAt: deps.clock.now))
            }
        } catch {
            if !hasLoaded { loadError = Failure.message(error) }
        }
    }

    private func apply(_ result: TrainingBlocksQueryResult) {
        blocks = result.blocks ?? []
        objectives = result.objectives ?? []
        current = result.current
        hasLoaded = true
    }

    // MARK: - Reads

    public func block(id: String) -> BlockSummary? { blocks.first { $0.id == id } }
    public func objective(id: String?) -> Objective? { id.flatMap { id in objectives.first { $0.id == id } } }
    public func objective(for block: BlockSummary) -> Objective? { block.objective ?? objective(id: block.objectiveId) }

    /// "week 2 of 4" while a block is under way; "4 weeks" otherwise.
    public static func weekLabel(_ block: BlockSummary) -> String {
        if let week = block.currentWeek { return "week \(week) of \(block.weeks)" }
        return "\(block.weeks) week\(block.weeks == 1 ? "" : "s")"
    }

    /// "Aug 31 – Sep 27" — the inclusive range (`blockPeriod().label`).
    public static func periodLabel(startDate: String, endDateExclusive: String) -> String {
        guard let start = DayKey(startDate), let endExclusive = DayKey(endDateExclusive) else {
            return "\(startDate) – \(endDateExclusive)"
        }
        let end = endExclusive.adding(days: -1)
        return "\(LibraryModel.shortDate(start)) – \(LibraryModel.shortDate(end))"
    }

    /// "Aug 31 – Sep 27, 2026" for the cycle preview's footer line.
    public static func periodLabelWithYear(startDate: String, endDateExclusive: String) -> String {
        guard let endExclusive = DayKey(endDateExclusive) else { return periodLabel(startDate: startDate, endDateExclusive: endDateExclusive) }
        return "\(periodLabel(startDate: startDate, endDateExclusive: endDateExclusive)), \(endExclusive.adding(days: -1).year)"
    }

    // MARK: - Progress

    private struct CachedProgress: Codable {
        let today: String
        let progress: BlockProgress
    }

    /// One block's attainment for today: the cache when it was computed for
    /// this same day and nothing was written since, else the server.
    public func loadProgress(id: String) async {
        let key = ScheduleCacheKey.blockProgress(id: id)
        if !progressStale, progress[id] == nil,
           let entry = try? await deps.cache.read(kind: .blocks, key: key),
           let cached = try? JSONDecoder().decode(CachedProgress.self, from: entry.json),
           cached.today == today.string {
            progress[id] = cached.progress
        }
        do {
            let envelope = try await deps.client.send(
                .query(tool: "get_training_blocks", args: TrainingBlocksQueryResult.args(blockId: id, today: today.string)),
                as: QueryEnvelope<TrainingBlocksQueryResult>.self
            )
            guard let fresh = envelope.result.block?.progress else { return }
            progress[id] = fresh
            progressFailed.remove(id)
            if let json = try? JSONEncoder().encode(CachedProgress(today: today.string, progress: fresh)) {
                try? await deps.cache.write(CacheEntry(kind: .blocks, key: key, json: json, fetchedAt: deps.clock.now))
            }
        } catch {
            if progress[id] == nil { progressFailed.insert(id) }
        }
    }

    // MARK: - Writes

    private func afterWrite(_ notice: String) async {
        pendingNotice = notice
        progress = [:]
        progressStale = true
        await refresh()
    }

    /// nil = written; a message = the refusal the sheet shows inline (the
    /// server's own text: an overlap is "That date range overlaps an existing block").
    public func createBlock(_ form: BlockForm) async -> String? {
        do {
            _ = try await deps.client.data(for: .createBlock(row: form.row(), name: form.name.trimmingCharacters(in: .whitespaces)))
        } catch {
            return Failure.message(error)
        }
        await afterWrite("Block created")
        return nil
    }

    public func updateBlock(_ block: BlockSummary, _ form: BlockForm) async -> String? {
        do {
            _ = try await deps.client.data(for: .updateBlock(id: block.id, fields: form.row(), name: block.name))
        } catch {
            return Failure.message(error)
        }
        await afterWrite("Block updated")
        return nil
    }

    public func deleteBlock(_ block: BlockSummary) async -> String? {
        do {
            _ = try await deps.client.data(for: .deleteBlock(id: block.id, name: block.name))
        } catch {
            return Failure.message(error)
        }
        await afterWrite("Block deleted")
        return nil
    }

    public enum ObjectiveOutcome: Sendable, Equatable {
        case created(Objective)
        case problem(String)
    }

    /// The inline "new objective": created, re-read with the list, handed
    /// back so the editor can select it.
    public func createObjective(name rawName: String, targetDate: DayKey?, discipline: String?) async -> ObjectiveOutcome {
        let name = rawName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return .problem("Give the objective a name") }
        nonisolated struct Created: Decodable, Sendable { let id: String }
        let created: Created
        do {
            created = try await deps.client.send(.createObjective(name: name, targetDate: targetDate?.string, discipline: discipline), as: Created.self)
        } catch {
            return .problem(Failure.message(error))
        }
        await refresh()
        return .created(objective(id: created.id) ?? Objective(id: created.id, name: name, discipline: discipline, targetDate: targetDate?.string))
    }

    // MARK: - The cycle preview

    /// Every edit re-previews after the debounce; a newer edit drops an older answer.
    public func scheduleCyclePreview(_ spec: CycleSpec) {
        generation += 1
        let mine = generation
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            guard let self else { return }
            if previewDelay > .zero {
                try? await Task.sleep(for: previewDelay)
            }
            guard !Task.isCancelled, mine == generation else { return }
            await computePreview(spec, generation: mine)
        }
    }

    private func computePreview(_ spec: CycleSpec, generation mine: Int) async {
        preview = .loading
        let result: PreviewState
        do {
            let response = try await deps.client.send(.cyclePreview(spec: spec), as: CyclePreviewResponse.self)
            result = response.ok ? .ready(response) : .problem(response.problem ?? "That cycle can’t be built")
        } catch {
            result = .failed(Failure.message(error))
        }
        guard mine == generation else { return }
        preview = result
    }

    public func resetPreview() {
        previewTask?.cancel()
        previewTask = nil
        generation += 1
        preview = .idle
    }

    /// Commit a previewed cycle: the server's rows go back verbatim, in one
    /// statement. nil = created; a message = the refusal (an overlap the
    /// preview did not see is the DB's 409).
    public func commitCycle(_ response: CyclePreviewResponse) async -> String? {
        guard let rows = response.rows, let blocks = response.blocks, !rows.isEmpty else { return "Nothing to create yet" }
        do {
            _ = try await deps.client.data(for: .createBlocks(rows: rows, firstName: blocks[0].name))
        } catch {
            return Failure.message(error)
        }
        let weeks = response.totalWeeks.map { " — \($0) weeks" } ?? ""
        await afterWrite("Added \(blocks.count) blocks\(weeks)")
        return nil
    }

    /// The screen under a closed sheet posts what the sheet could not.
    public func flushNotice() {
        guard let notice = pendingNotice else { return }
        pendingNotice = nil
        ToastBus.shared.post(notice, level: .success)
    }
}
