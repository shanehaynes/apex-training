import ApexCore
import ApexUI
import Foundation
import Observation

/// The tile builder's state (`TileBuilder.tsx` + `AnalyticsCoachPanel.tsx`):
/// one `ChartDraft` every input writes into, a live preview the server
/// computes from that draft (debounced, one in flight, stale answers
/// dropped), the catalog's dimming rules, an analytics-mode coach whose
/// reduces land on the same draft, and Save through the draft body. Nothing
/// about draft→spec or validation lives here (D-008, D-029): a draft the web
/// would refuse comes back as the preview's problem, in the web's words.
@MainActor
@Observable
public final class TileBuilderModel {
    public enum PreviewState: Equatable, Sendable {
        case idle, loading
        case ready(TileData)
        /// The server's `chartDraftProblem` / `specProblem` text.
        case problem(String)
        /// The request never landed.
        case failed(String)
    }

    public private(set) var draft: ChartDraft
    public private(set) var preview: PreviewState = .idle
    public private(set) var isSaving = false
    public private(set) var coach: CoachModel?
    public var coachOpen = false
    public var confirmDiscard = false
    /// Series whose Filters disclosure is open.
    public var filtersOpen: Set<String> = []

    public let editing: AnalyticsTile?
    let model: AnalyticsModel
    private let coachServices: CoachServices?
    private var original: ChartDraft
    private var previewTask: Task<Void, Never>?
    private var generation = 0
    /// The settle time before a preview request; tests set it to zero.
    public var previewDelay: Duration = .milliseconds(300)

    public init(model: AnalyticsModel, tile: AnalyticsTile?, coachServices: CoachServices? = nil) {
        self.model = model
        self.editing = tile
        self.coachServices = coachServices
        let initial = tile?.draft ?? .empty
        draft = initial
        original = initial
        for series in initial.series where Self.hasFilters(series) { filtersOpen.insert(series.id) }
    }

    // Under MainActor default isolation the deinit would be synthesized as
    // *isolated*, which routes deallocation through swift_task_deinitOnExecutor
    // and aborts on the iOS 17/18 runtime when the object dies outside a task
    // (swiftlang/swift#87316, D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

    // MARK: - Lifecycle

    public func start() async {
        schedulePreview()
        guard coach == nil, let coachServices else { return }
        let coach = CoachModel(
            services: coachServices, mode: .analytics, draft: try? draft.jsonValue(),
            onDraft: { [weak self] reduced in self?.apply(reduced: reduced) },
            placeholder: "e.g. “Weekly running mileage, last 3 months”"
        )
        self.coach = coach
        await coach.start()
    }

    public func shutdown() {
        previewTask?.cancel()
        coach?.shutdown()
    }

    // MARK: - Derived

    public var isEditing: Bool { editing != nil }
    public var isDirty: Bool { draft != original }
    public var canCoach: Bool { coach != nil }
    public var title: String { isEditing ? "Edit tile" : "New tile" }
    public var options: TileOptions { model.options }
    public var canAddSeries: Bool { draft.series.count < AnalyticsCatalog.maxSeries }
    /// A KPI is one number; the bucket chips are hidden rather than errored.
    public var showsBucket: Bool { draft.chartType != "kpi" }
    /// Only a length measure has a unit to choose.
    public var showsDisplayUnit: Bool {
        draft.series.contains { measure(for: $0)?.unitKind == "length" }
    }

    public func measure(for series: SeriesDraft) -> AnalyticsCatalog.Measure? {
        AnalyticsCatalog.measure(series.measure)
    }

    /// `Incompatible with <sports>`: a sports filter already chosen
    /// constrains which measures still make sense (the web's measure dimming).
    public func measureDimReason(seriesId: String, measureId: String) -> String? {
        guard let series = draft.series.first(where: { $0.id == seriesId }), series.measure != measureId,
              let measure = AnalyticsCatalog.measure(measureId) else { return nil }
        let blockedBy = series.sports.filter { measure.blockedSports.contains($0) }
        return blockedBy.isEmpty ? nil : "Incompatible with \(blockedBy.joined(separator: ", "))"
    }

    /// `Incompatible with <measure label>`: the chosen measure rules a sport out.
    public func sportDimReason(seriesId: String, sport: String) -> String? {
        guard let series = draft.series.first(where: { $0.id == seriesId }), let measure = measure(for: series),
              measure.blockedSports.contains(sport) else { return nil }
        return "Incompatible with \(measure.label)"
    }

    /// Which filter rows a series shows, by its measure's source.
    public func filterVisibility(for series: SeriesDraft) -> (sports: Bool, logs: Bool, eventTypes: Bool, meals: Bool) {
        guard let source = measure(for: series)?.source else { return (false, false, false, false) }
        let workout = source != "meals"
        return (workout, ["set-logs", "pitch-logs", "cardio-logs"].contains(source), workout, source == "meals")
    }

    static func hasFilters(_ s: SeriesDraft) -> Bool {
        !s.eventTypes.isEmpty || !s.sports.isEmpty || !s.exerciseNames.isEmpty || !s.categories.isEmpty || !s.mealTypes.isEmpty || !s.dayFilterTypes.isEmpty
    }

    // MARK: - The draft

    /// Every input writes here; the coach's next reduce starts from here too,
    /// and the preview follows after the settle time.
    public func update(_ change: (inout ChartDraft) -> Void) {
        var next = draft
        change(&next)
        guard next != draft else { return }
        draft = next
        pushDraftToCoach()
        schedulePreview()
    }

    public func updateSeries(_ id: String, _ change: (inout SeriesDraft) -> Void) {
        update { draft in
            guard let index = draft.series.firstIndex(where: { $0.id == id }) else { return }
            change(&draft.series[index])
        }
    }

    /// Picking a measure resets what depended on the old one (`onPatch({ measure, agg: '', groupBy: '' })`).
    public func setMeasure(_ seriesId: String, _ measureId: String) {
        updateSeries(seriesId) { series in
            series.measure = measureId
            series.agg = ""
            series.groupBy = ""
        }
    }

    public func toggle(_ seriesId: String, _ keyPath: WritableKeyPath<SeriesDraft, [String]>, _ value: String) {
        updateSeries(seriesId) { series in
            if let index = series[keyPath: keyPath].firstIndex(of: value) {
                series[keyPath: keyPath].remove(at: index)
            } else {
                series[keyPath: keyPath].append(value)
            }
        }
    }

    /// The comma-separated exercises field, split as the web splits it.
    public func setExerciseNames(_ seriesId: String, text: String) {
        updateSeries(seriesId) { $0.exerciseNames = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    }

    public func addSeries() {
        guard canAddSeries else { return }
        update { $0.series.append(.empty(id: $0.nextSeriesId())) }
    }

    public func removeSeries(_ id: String) {
        update { $0.series.removeAll { $0.id == id } }
    }

    /// The coach reduced the draft on the server: it replaces the form.
    public func apply(reduced: JSONValue) {
        guard let next = try? ChartDraft(jsonValue: reduced) else { return }
        draft = next
        schedulePreview()
    }

    private func pushDraftToCoach() {
        guard let coach, let json = try? draft.jsonValue() else { return }
        coach.updateDraft(json)
    }

    // MARK: - The preview

    /// One request after the draft settles; a newer edit cancels the wait
    /// and any answer that arrives for an older draft is dropped.
    public func schedulePreview() {
        generation += 1
        let mine = generation
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            guard let self else { return }
            if previewDelay > .zero {
                try? await Task.sleep(for: previewDelay)
            }
            guard !Task.isCancelled, mine == generation else { return }
            await computePreview(generation: mine)
        }
    }

    private func computePreview(generation mine: Int) async {
        preview = .loading
        let draft = draft
        let result: PreviewState
        do {
            let data = try await model.deps.client.data(for: .analyticsPreview(draft: draft, today: model.today.string))
            let response = try JSONDecoder().decode(AnalyticsComputeResponse.self, from: data)
            switch response.tiles.first {
            case .ok(let tile)?: result = .ready(tile)
            case .problem(let problem)?: result = .problem(problem)
            case nil: result = .failed("The preview came back empty.")
            }
        } catch {
            result = .failed(AnalyticsModel.readable(error))
        }
        guard mine == generation else { return }
        preview = result
    }

    // MARK: - Save

    /// `POST /api/analytics-tiles { id, draft, layout }`. nil result = the
    /// request never landed (toasted); `ok:false` = the server's text
    /// (toasted, the form stays); `ok:true` = the tile is on the dashboard.
    public func save() async -> Bool {
        let id = editing?.id ?? TileID.mint()
        let layout = editing?.layout ?? TileLayoutPlan.nextLayout(after: model.tiles, height: .medium)
        isSaving = true
        defer { isSaving = false }
        let response: TileSaveResponse
        do {
            let data = try await model.deps.client.data(for: .saveTile(id: id, draft: draft, layout: layout))
            response = try JSONDecoder().decode(TileSaveResponse.self, from: data)
        } catch {
            ToastBus.shared.post(AnalyticsModel.isNetwork(error) ? "No connection — couldn't save. Try again when you're back online." : "Failed to save — try again", level: .failure)
            return false
        }
        guard response.ok, let tile = response.tile else {
            ToastBus.shared.post(response.problem ?? "Failed to save — try again", level: .failure)
            return false
        }
        ToastBus.shared.post(isEditing ? "Tile updated" : "Tile added", level: .success)
        original = draft
        let result: TileResult? = { if case .ready(let data) = preview { return .ok(data) } else { return nil } }()
        await model.saved(tile, result: result)
        return true
    }
}
