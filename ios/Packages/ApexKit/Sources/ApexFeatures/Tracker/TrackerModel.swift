import ApexActivity
import ApexCore
import ApexUI
import Foundation
import Observation

/// The tracker screen's state (D-006): a `TrackerEditor` over the server-built
/// model, the write queue for every write, the finish gate, and the summary.
/// Mirrors `useWorkoutSession.ts`, with the offline path the web never had:
/// the cache renders first, edits become queued ops, and a finish made offline
/// fills in its PRs when the flush returns (architecture.md §7).
@MainActor
@Observable
public final class TrackerModel {
    public enum Phase: Equatable {
        case loading
        case ready
        /// Nothing cached and no network: the model is server-built, so there is nothing to show.
        case unavailable(String)
    }

    public enum Gate: Equatable {
        case idle
        case needsConfirm(count: Int)
        case needsScore
        case finishing
        case confirmCancel
        case cancelling
    }

    public enum CoachStatus: Equatable {
        case loading
        case ready
        case unavailable(String)
    }

    /// What the summary overlay shows (`SummaryState` on the web) plus
    /// `pendingSync`: the finish is queued and the PRs are not back yet.
    public struct Summary: Equatable {
        public var prs: [PersonalRecord]
        public var scoreRecord: ScoreRecord?
        public var score: SessionScore?
        public var coachText: String?
        public var coachStatus: CoachStatus
        public var pendingSync: Bool
        public var durationSeconds: Int?

        public init(
            prs: [PersonalRecord], scoreRecord: ScoreRecord?, score: SessionScore?, coachText: String?,
            coachStatus: CoachStatus, pendingSync: Bool, durationSeconds: Int?
        ) {
            self.prs = prs
            self.scoreRecord = scoreRecord
            self.score = score
            self.coachText = coachText
            self.coachStatus = coachStatus
            self.pendingSync = pendingSync
            self.durationSeconds = durationSeconds
        }
    }

    public enum ScoreChoice: Equatable {
        case notAsked
        case skipped
        case entered(SessionScore)
    }

    public let event: ScheduleEvent
    public let session: SessionKey

    public private(set) var phase: Phase = .loading
    public private(set) var editor: TrackerEditor
    public private(set) var startedAt: Date?
    public private(set) var isFinished = false
    public private(set) var totalDurationSeconds: Int?
    public private(set) var elapsed = 0
    public private(set) var gate: Gate = .idle
    public private(set) var summary: Summary?
    public private(set) var sync: SessionSyncStatus = .idle
    public private(set) var scored = false
    public private(set) var savedScore: SessionScore?
    public private(set) var savedPRs: [PersonalRecord] = []
    public private(set) var savedScoreRecord: ScoreRecord?
    public private(set) var coachSummary: String?
    public private(set) var definitions: [ExerciseDefinition] = []
    public private(set) var isSwapping = false

    /// `.sensoryFeedback` triggers (design-spec §9): bump, never reset.
    public private(set) var loggedSetCount = 0
    public private(set) var prCount = 0
    public private(set) var confirmCount = 0
    public private(set) var completedCount = 0

    private let deps: TrackerDependencies
    private var services: TrackerServices { deps.services }
    private var saveGeneration = 0
    private var timerTask: Task<Void, Never>?
    private var queueTask: Task<Void, Never>?
    private var isPresented = false

    /// The web's `AUTOSAVE_DEBOUNCE_MS`.
    public static let autosaveDebounce: Double = 0.8
    public static let coachUnavailable = "Coach's summary unavailable right now — here's what you did."
    public static let summaryPendingSync = "Summary available once the workout syncs."

    public init(event: ScheduleEvent, deps: TrackerDependencies) {
        self.event = event
        self.session = SessionKey(eventId: event.id, eventDate: event.date)
        self.deps = deps
        self.editor = TrackerEditor(groups: [], session: session)
        self.scored = event.base.templateId != nil && ["for-time", "amrap"].contains(event.base.scoringType ?? "")
    }

    // MARK: - Lifecycle

    /// Cache → render → replay the queue → flush → network → refresh what is
    /// not ahead locally. On `.network` with a cached peek and no session, this
    /// is the offline start: stamp now, queue `start`, and remember it.
    public func open() async {
        isPresented = true
        let cached = await readCachedBootstrap()
        if let cached { apply(cached) }
        await replayQueue()
        subscribeToQueue()
        definitions = await deps.definitions()
        await services.queue.flush(session)

        let pendingStart = await services.queue.pendingStart(for: session)
        do {
            let data = try await services.client.data(for: .trackerBootstrap(
                eventId: session.eventId, eventDate: session.eventDate, startedAt: pendingStart ?? nil
            ))
            let fresh = try JSONDecoder().decode(TrackerBootstrap.self, from: data)
            let status = await services.queue.status(for: session)
            if phase == .ready {
                editor.replaceGroupsIfClean(fresh.groups, queueHasPending: status.pendingOps > 0)
                applySession(fresh)
            } else {
                apply(fresh)
            }
            if !status.hasPendingFinish { await writeCache(fresh) }
        } catch {
            await handleOpenFailure(error, cached: cached)
        }
        sync = await services.queue.status(for: session)
        startTimer()
        await syncActivity()
    }

    /// Back: flush what is dirty into the queue, then let the queue try. The
    /// Live Activity stays up — leaving the screen is not leaving the gym.
    public func close() async {
        isPresented = false
        await flushEdits()
        timerTask?.cancel()
        queueTask?.cancel()
        let queue = services.queue
        let session = session
        Task { await queue.flush(session) }
    }

    private func apply(_ bootstrap: TrackerBootstrap) {
        editor = TrackerEditor(bootstrap: bootstrap, session: session)
        applySession(bootstrap)
        phase = .ready
    }

    private func applySession(_ bootstrap: TrackerBootstrap) {
        if let session = bootstrap.session {
            startedAt = session.startedAt.flatMap(Self.parseISO)
            isFinished = session.finishedAt != nil
            totalDurationSeconds = session.totalDurationSeconds
            coachSummary = session.coachSummary
            savedScore = SessionScore(session: session)
        }
        scored = bootstrap.scored
        savedPRs = bootstrap.prs ?? []
        savedScoreRecord = bootstrap.scoreRecord
    }

    private func handleOpenFailure(_ error: Error, cached: TrackerBootstrap?) async {
        guard Self.isOffline(error) else {
            if phase == .loading { phase = .unavailable(Self.readable(error)) } else { ToastBus.shared.post(Self.readable(error), level: .failure) }
            return
        }
        guard let cached else {
            phase = .unavailable("No connection. Open this workout once while online so it can start offline.")
            return
        }
        if cached.session == nil, startedAt == nil {
            // The offline start: the phone's time is the session's start, queued
            // so the server stamps it exactly, and cached so a relaunch resumes.
            let now = services.clock.now
            let stamp = CompletionRows.isoTimestamp(now)
            startedAt = now
            try? await services.queue.enqueue(.start(startedAt: stamp), for: session)
            var local = cached
            local.session = TrackerBootstrap.Session(
                id: "local", userId: "", eventId: session.eventId, eventDate: session.eventDate, startedAt: stamp
            )
            await writeCache(local)
        }
    }

    /// Edits the server has not seen yet, replayed before the first frame; a
    /// queued finish means the session is finished here even if not there.
    private func replayQueue() async {
        for save in await services.queue.pendingSaves(for: session) { editor.apply(save) }
        for swap in await services.queue.pendingSwaps(for: session) {
            editor.swap(section: swap.section, exerciseId: swap.exerciseId, toName: swap.exerciseName, definitionId: swap.definitionId)
        }
        if case .some(let stamp) = await services.queue.pendingStart(for: session), let stamp, startedAt == nil {
            startedAt = Self.parseISO(stamp)
        }
        if let finish = await services.queue.pendingFinish(for: session), !isFinished {
            isFinished = true
            editor.apply(SavePayload(setLogs: finish.autofillRows))
            summary = Summary(
                prs: [], scoreRecord: nil, score: finish.score?.score, coachText: nil,
                coachStatus: .unavailable(Self.summaryPendingSync), pendingSync: true,
                durationSeconds: totalDurationSeconds
            )
        }
    }

    private func subscribeToQueue() {
        queueTask?.cancel()
        let queue = services.queue
        queueTask = Task { [weak self] in
            for await event in await queue.subscribe() {
                guard let self, !Task.isCancelled else { return }
                await self.handle(event)
            }
        }
    }

    private func handle(_ event: QueueEvent) async {
        switch event {
        case .changed(let key) where key == session:
            sync = await services.queue.status(for: session)
        case .finished(let key, let response) where key == session:
            await finishLanded(response)
        case .failed(let key, _, _) where key == session:
            sync = await services.queue.status(for: session)
        default:
            break
        }
    }

    private func startTimer() {
        timerTask?.cancel()
        tick()
        // Real seconds, deliberately not the injected clock: a test clock that
        // jumps on every sleep would spin this loop.
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                self.tick()
            }
        }
    }

    private func tick() {
        if isFinished, let total = totalDurationSeconds {
            elapsed = total
        } else if let startedAt {
            elapsed = max(0, Int(services.clock.now.timeIntervalSince(startedAt)))
        }
    }

    // MARK: - Live Activity (W12)

    /// A running session gets (or keeps) its activity; a session that is not
    /// started, already finished, or unavailable gets nothing. Idempotent —
    /// the publisher only updates when the snapshot changed.
    private func syncActivity() async {
        guard phase == .ready, !isFinished, let startedAt else { return }
        await services.activity.sync(TrackerActivitySnapshot(
            session: session, title: event.title, startedAt: startedAt,
            exerciseCount: editor.groups.reduce(0) { $0 + $1.exercises.count }
        ))
    }

    // MARK: - Edits

    public func set(at key: SetKey) -> TrackedSet? { editor.set(at: key) }

    public func setValue(_ value: String, _ field: SetField, at key: SetKey) {
        guard editor.setValue(value, field, at: key) else { return }
        scheduleSave()
    }

    /// First focus in a shadowed row commits the ghost (`focusShadow` on the
    /// web). Returns true when it did, so the field can select its text and the
    /// first keystroke replaces rather than appends.
    @discardableResult
    public func focusSet(at key: SetKey) -> Bool {
        guard let tracked = editor.exercise(section: key.section, id: key.exerciseId) else { return false }
        guard editor.commitShadow(at: key, fields: inputFields(for: tracked)) else { return false }
        loggedSetCount += 1
        scheduleSave()
        return true
    }

    public func setCardio(_ value: String, _ field: CardioField, at key: CardioKey) {
        guard editor.setCardio(value, field, at: key) else { return }
        scheduleSave()
    }

    @discardableResult
    public func focusCardio(_ field: CardioField, at key: CardioKey) -> Bool {
        guard editor.commitCardioShadow(field, at: key) else { return false }
        scheduleSave()
        return true
    }

    /// U28: one tap takes every ghost row of an exercise.
    public func useLast(section: String, exerciseId: String) {
        guard let tracked = editor.exercise(section: section, id: exerciseId) else { return }
        let count = editor.commitAllShadows(section: section, exerciseId: exerciseId, fields: inputFields(for: tracked))
        guard count > 0 else { return }
        loggedSetCount += count
        scheduleSave()
    }

    public func hasShadows(section: String, exerciseId: String) -> Bool {
        editor.exercise(section: section, id: exerciseId)?.sets.contains { $0.shadow != nil } ?? false
    }

    public func addSet(section: String, exerciseId: String) {
        editor.addExtraSet(section: section, exerciseId: exerciseId)
    }

    public func removeSet(at key: SetKey) {
        guard editor.removeExtraSet(at: key) else { return }
        scheduleSave()
    }

    /// A set the user just left with something in it: the "set logged" haptic.
    public func didLeaveSet(_ key: SetKey) {
        if editor.set(at: key)?.hasAnyActual == true, editor.dirtySets.contains(key) { loggedSetCount += 1 }
    }

    private func scheduleSave() {
        saveGeneration += 1
        let mine = saveGeneration
        let clock = services.clock
        Task { [weak self] in
            try? await clock.sleep(seconds: Self.autosaveDebounce)
            guard let self, self.saveGeneration == mine else { return }
            await self.flushEdits()
        }
    }

    /// Dirty keys → one queued `save` → a flush attempt. The payload is in the
    /// durable queue before anything is awaited on the network.
    public func flushEdits() async {
        saveGeneration += 1
        guard let payload = editor.takeSavePayload() else { return }
        do {
            try await services.queue.enqueue(.save(payload), for: session)
        } catch {
            ToastBus.shared.post("Could not queue the save: \(error.localizedDescription)", level: .failure)
            return
        }
        await services.queue.flush(session)
        sync = await services.queue.status(for: session)
    }

    // MARK: - Display helpers

    public func definition(for tracked: TrackedExercise) -> ExerciseDefinition? {
        guard tracked.substitutedFrom != nil, let id = tracked.exercise.definitionId else { return nil }
        return definitions.first { $0.id == id }
    }

    public func inputFields(for tracked: TrackedExercise) -> [SetField] {
        TrackerEditor.inputFields(for: tracked, swappedTo: definition(for: tracked))
    }

    public func perSideWarning(for tracked: TrackedExercise) -> String? {
        guard editor.needsPerSideWarning(section: tracked.section, exerciseId: tracked.exercise.id, swappedTo: definition(for: tracked)) else { return nil }
        return "\(tracked.exercise.name) is unilateral — reps are counted per side, so check they read that way (e.g. \"8 each arm\")."
    }

    public func nextField(after current: FieldID) -> FieldID? {
        let order = editor.fieldOrder { self.inputFields(for: $0) }
        guard let i = order.firstIndex(of: current), i + 1 < order.count else { return nil }
        return order[i + 1]
    }

    public var syncLabel: String? {
        guard sync.failedOps == 0 else { return nil }
        let pending = sync.pendingSets + sync.pendingCardio
        if pending > 0 { return "\(pending) set\(pending == 1 ? "" : "s") pending sync" }
        if sync.hasPendingFinish { return "Finish pending sync" }
        return nil
    }

    public var failureLabel: String? {
        guard sync.failedOps > 0 else { return nil }
        if sync.failedSets > 0 { return "\(sync.failedSets) set\(sync.failedSets == 1 ? "" : "s") could not be saved." }
        return "Could not sync this workout."
    }

    public var elapsedLabel: String { DurationBuffer.formatElapsed(elapsed) }

    public var dateLabel: String {
        "\(MonthNames.weekdayLong[event.day.weekday - 1]), \(MonthNames.short[event.day.month - 1]) \(event.day.day)"
    }

    // MARK: - Finish

    /// The web's `requestFinish`: unlogged planned sets need a confirm, a scored
    /// template needs its score, then the finish is queued along with the
    /// calendar completion. `force` is the confirm bar's "Finish anyway".
    public func requestFinish(force: Bool = false, score: ScoreChoice = .notAsked) async {
        guard phase == .ready, !isFinished, gate != .finishing else { return }
        if !force {
            let count = editor.unloggedPlannedCount
            if count > 0 {
                gate = .needsConfirm(count: count)
                return
            }
        }
        var submission: ScoreSubmission?
        if scored {
            switch score {
            case .notAsked:
                gate = .needsScore
                return
            case .skipped:
                submission = nil
            case .entered(let value):
                if let templateId = event.base.templateId { submission = ScoreSubmission(templateId: templateId, score: value) }
            }
        }
        gate = .finishing
        confirmCount += 1
        await flushEdits()

        let now = services.clock.now
        let autofill = editor.collectUntouchedPlanned()
        let finish = FinishPayload(autofillRows: autofill, finishedAt: CompletionRows.isoTimestamp(now), score: submission)
        let rows = CompletionRows.build(for: event, isNowCompleted: true, now: now)
        do {
            try await services.queue.enqueue(.finish(finish), for: session)
            try await services.queue.enqueue(.completion(completionRow: rows.completionRow, logRow: rows.logRow), for: session)
        } catch {
            gate = .idle
            ToastBus.shared.post("Could not finish: \(error.localizedDescription)", level: .failure)
            return
        }
        deps.onCompletionChanged(event, true, rows.completionRow.completedAt)

        editor.apply(SavePayload(setLogs: autofill))
        isFinished = true
        totalDurationSeconds = elapsed
        savedScore = submission?.score
        completedCount += 1
        summary = Summary(
            prs: [], scoreRecord: nil, score: submission?.score, coachText: nil,
            coachStatus: .unavailable(Self.summaryPendingSync), pendingSync: true, durationSeconds: elapsed
        )
        gate = .idle
        await markCachedFinished(at: finish.finishedAt, total: elapsed)
        await services.activity.end(session, totalSeconds: elapsed)
        let queue = services.queue
        let session = session
        Task { await queue.flush(session) }
    }

    public func keepGoing() { gate = .idle }

    /// `.finished` from the queue: the server's PRs and recap have arrived.
    private func finishLanded(_ response: FinishResponse?) async {
        sync = await services.queue.status(for: session)
        if let response {
            savedPRs = response.prs
            savedScoreRecord = response.scoreRecord
            if !response.prs.isEmpty || response.scoreRecord != nil { prCount += 1 }
        }
        guard isPresented else {
            let prs = response?.prs.count ?? 0
            ToastBus.shared.post(prs > 0 ? "Workout synced · \(prs) PR\(prs == 1 ? "" : "s")" : "Workout synced", level: .success)
            return
        }
        if var current = summary {
            current.prs = response?.prs ?? []
            current.scoreRecord = response?.scoreRecord
            current.durationSeconds = response?.totalDurationSeconds ?? current.durationSeconds
            current.pendingSync = false
            current.coachStatus = .loading
            summary = current
            totalDurationSeconds = current.durationSeconds
            await streamCoachSummary()
        }
    }

    /// `POST /api/coach-summary`: text deltas into the overlay as they arrive;
    /// an in-band `error`, an empty answer, a 402 or a 409 all degrade to copy.
    public func streamCoachSummary() async {
        guard summary != nil else { return }
        summary?.coachStatus = .loading
        summary?.coachText = nil
        var text = ""
        do {
            let events = try await services.client.wireEvents(for: .coachSummary(eventId: session.eventId, eventDate: session.eventDate))
            for try await event in events {
                switch event {
                case .text(let delta):
                    text += delta
                    summary?.coachText = text
                case .error(let message):
                    throw APIError.server(status: 200, message: message)
                case .done, .toolUse:
                    break
                }
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                summary?.coachStatus = .unavailable(Self.coachUnavailable)
                return
            }
            summary?.coachText = trimmed
            summary?.coachStatus = .ready
            coachSummary = trimmed
            await cacheCoachSummary(trimmed)
        } catch let error as APIError {
            if case .server(let status, _) = error, status == 409 {
                summary?.coachStatus = .unavailable(Self.summaryPendingSync)
            } else {
                summary?.coachStatus = .unavailable(Self.coachUnavailable)
            }
        } catch {
            summary?.coachStatus = .unavailable(Self.coachUnavailable)
        }
    }

    /// The Done badge on a finished session: the records came with the
    /// bootstrap and the summary text may have too, so no request is needed.
    public func openSavedSummary() async {
        summary = Summary(
            prs: savedPRs, scoreRecord: savedScoreRecord, score: savedScore,
            coachText: coachSummary, coachStatus: coachSummary == nil ? .loading : .ready,
            pendingSync: sync.hasPendingFinish, durationSeconds: totalDurationSeconds
        )
        if sync.hasPendingFinish {
            summary?.coachStatus = .unavailable(Self.summaryPendingSync)
        } else if coachSummary == nil {
            await streamCoachSummary()
        }
    }

    public func dismissSummary() { summary = nil }

    // MARK: - Cancel

    public func confirmCancel() { gate = .confirmCancel }

    /// Deletes everything logged for the session, here and on the server:
    /// pending edits dropped, queued ops purged, `cancel` queued, and the
    /// calendar flipped back if the session had been finished.
    public func cancelWorkout() async -> Bool {
        gate = .cancelling
        confirmCount += 1
        saveGeneration += 1
        _ = editor.takeSavePayload()
        do {
            try await services.queue.cancelSession(session)
            if isFinished {
                let rows = CompletionRows.build(for: event, isNowCompleted: false, now: services.clock.now)
                try await services.queue.enqueue(.completion(completionRow: rows.completionRow, logRow: rows.logRow), for: session)
                deps.onCompletionChanged(event, false, nil)
            }
        } catch {
            gate = .idle
            ToastBus.shared.post("Could not cancel: \(error.localizedDescription)", level: .failure)
            return false
        }
        try? await services.cache.purge(kind: .trackerBootstrap)
        isPresented = false
        timerTask?.cancel()
        await services.activity.end(session, totalSeconds: nil)
        let queue = services.queue
        let session = session
        Task { await queue.flush(session) }
        return true
    }

    // MARK: - Swap

    /// The movements a logged exercise may be swapped onto: same logged shape
    /// (cardio ↔ cardio; everything else ↔ set-tracked), never archived, never
    /// a pitch. Matched on name, aliases and muscle groups.
    public static func swapCandidates(_ definitions: [ExerciseDefinition], for tracked: TrackedExercise, query: String) -> [ExerciseDefinition] {
        let allowed: Set<String> = tracked.isCardio ? ["cardio"] : ["strength", "stretch", "mobility", "skill"]
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return definitions
            .filter { $0.archivedAt == nil && allowed.contains($0.category ?? "") }
            .filter { definition in
                guard !needle.isEmpty else { return true }
                if definition.canonicalName.lowercased().contains(needle) { return true }
                if (definition.aliases ?? []).contains(where: { $0.lowercased().contains(needle) }) { return true }
                return (definition.muscleGroups ?? []).contains { $0.lowercased().contains(needle) }
            }
            .sorted { $0.canonicalName.localizedCaseInsensitiveCompare($1.canonicalName) == .orderedAscending }
    }

    public func canSwap(_ tracked: TrackedExercise) -> Bool {
        tracked.exercise.category != "climbing" && !isFinishedAndClean(tracked)
    }

    private func isFinishedAndClean(_ tracked: TrackedExercise) -> Bool { false }

    /// Flush first — a pending save carries the old name and would overwrite
    /// the relabel — then relabel locally and queue the swap.
    public func swap(section: String, exerciseId: String, to definition: ExerciseDefinition) async {
        isSwapping = true
        defer { isSwapping = false }
        await flushEdits()
        guard editor.swap(section: section, exerciseId: exerciseId, toName: definition.canonicalName, definitionId: definition.id) else { return }
        let payload = SwapPayload(section: section, exerciseId: exerciseId, exerciseName: definition.canonicalName, definitionId: definition.id)
        do {
            try await services.queue.enqueue(.swapExercise(payload), for: session)
        } catch {
            ToastBus.shared.post("Failed to swap — try again", level: .failure)
            return
        }
        ToastBus.shared.post("Logged as \(definition.canonicalName)", level: .success)
        await services.queue.flush(session)
    }

    // MARK: - Failed ops

    public func retryFailed() async {
        await services.queue.retryFailed(session)
        sync = await services.queue.status(for: session)
    }

    public func discardFailed() async {
        await services.queue.discardFailed(session)
        sync = await services.queue.status(for: session)
    }

    // MARK: - Cache

    private var cacheKey: String { ScheduleCacheKey.trackerBootstrap(eventId: session.eventId, eventDate: session.eventDate) }

    private func readCachedBootstrap() async -> TrackerBootstrap? {
        guard let entry = try? await services.cache.read(kind: .trackerBootstrap, key: cacheKey) else { return nil }
        return try? JSONDecoder().decode(TrackerBootstrap.self, from: entry.json)
    }

    private func writeCache(_ bootstrap: TrackerBootstrap) async {
        guard let json = try? JSONEncoder().encode(bootstrap) else { return }
        try? await services.cache.write(CacheEntry(kind: .trackerBootstrap, key: cacheKey, json: json, fetchedAt: services.clock.now))
    }

    private func markCachedFinished(at finishedAt: String?, total: Int) async {
        guard var cached = await readCachedBootstrap() else { return }
        cached.session?.finishedAt = finishedAt
        cached.session?.totalDurationSeconds = total
        cached.groups = editor.groups
        await writeCache(cached)
    }

    private func cacheCoachSummary(_ text: String) async {
        guard var cached = await readCachedBootstrap() else { return }
        cached.session?.coachSummary = text
        await writeCache(cached)
    }

    // MARK: - Helpers

    static func isOffline(_ error: Error) -> Bool {
        guard let api = error as? APIError else { return false }
        switch api {
        // An expired JWT that cannot refresh offline surfaces as unauthorized
        // while the user is still signed in (ApexClient); treat it as offline.
        case .network, .unauthorized: return true
        default: return false
        }
    }

    static func readable(_ error: Error) -> String {
        (error as? APIError)?.description ?? error.localizedDescription
    }

    nonisolated static func parseISO(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}
