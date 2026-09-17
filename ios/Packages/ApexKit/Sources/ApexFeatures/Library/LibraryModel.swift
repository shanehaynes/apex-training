import ApexCore
import ApexUI
import Foundation
import Observation

/// What the Library screens need from the app (W10): the client and cache,
/// and the schedule's own cached definitions and templates — the one read
/// path for both (D-033), with ids — plus the hooks that keep the schedule
/// in step after a library write. Built by `AppModel` over `ScheduleModel`.
public struct LibraryDependencies: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var clock: any ApexClock
    /// The cached `/api/schedule?include=definitions` list.
    public var definitions: @MainActor @Sendable () async -> [ExerciseDefinition]
    /// The cached `/api/schedule?include=templates` list.
    public var templates: @MainActor @Sendable () async -> [WorkoutTemplate]
    /// A definition changed on the server: re-read the window so the cached
    /// list (and every exercise resolved through it) follows.
    public var refreshSchedule: @MainActor @Sendable () async -> Void
    /// The schedule's own archive/restore (it rewrites the templates cache).
    public var archiveTemplate: @MainActor @Sendable (_ id: String, _ archived: Bool) async -> Bool

    public init(
        client: ApexClient, cache: any CacheStore, clock: any ApexClock = SystemClock(),
        definitions: @escaping @MainActor @Sendable () async -> [ExerciseDefinition],
        templates: @escaping @MainActor @Sendable () async -> [WorkoutTemplate],
        refreshSchedule: @escaping @MainActor @Sendable () async -> Void = {},
        archiveTemplate: @escaping @MainActor @Sendable (String, Bool) async -> Bool = { _, _ in false }
    ) {
        self.client = client
        self.cache = cache
        self.clock = clock
        self.definitions = definitions
        self.templates = templates
        self.refreshSchedule = refreshSchedule
        self.archiveTemplate = archiveTemplate
    }
}

/// The exercise library and the workout library (`LibraryView.tsx`,
/// `ExerciseDetail.tsx`, `DefinitionEditor.tsx`, `TemplateSearch.tsx`): the
/// cached lists, decorated with the stats `search_exercises` computes —
/// last performed and "in N workouts" (U11) — and the writes the editor
/// makes. Nothing about aliases or history is computed here: a rename's
/// alias is the server's, and the detail's stats come from
/// `get_exercise_history`.
@MainActor
@Observable
public final class LibraryModel {
    public let deps: LibraryDependencies

    public private(set) var definitions: [ExerciseDefinition] = []
    public private(set) var templates: [WorkoutTemplate] = []
    /// `search_exercises` entries by definition id.
    public private(set) var stats: [String: SearchExercisesResult.Entry] = [:]
    public private(set) var isLoading = false
    /// The stats read failed and nothing was cached: rows show no stats.
    public private(set) var statsUnavailable = false
    /// A success message for the screen under a closing sheet to toast
    /// (a toast posted while the sheet is up renders under it, #167).
    public private(set) var pendingNotice: String?
    public var query = ""
    public var category = "all"
    private var isStarted = false
    private var histories: [String: HistoryOutcome] = [:]

    public static let categories = ["all"] + DefinitionForm.categories

    public init(deps: LibraryDependencies) {
        self.deps = deps
    }

    // Under the package's MainActor default isolation the deinit would be
    // isolated, and a model released while a hosting view tears down (the
    // snapshot tests) hops executors, which the iOS 17 back-deployed runtime
    // aborts on (D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

    // MARK: - Lifecycle

    /// Idempotent — the screen's `.task` runs on every appearance.
    public func start() async {
        guard !isStarted else { return }
        isStarted = true
        isLoading = true
        defer { isLoading = false }
        await readLists()
        await readCachedStats()
        await refreshStats()
    }

    /// Pull-to-refresh and after every write: the lists again, and the stats.
    public func reload() async {
        await readLists()
        await refreshStats()
    }

    private func readLists() async {
        definitions = await deps.definitions()
        templates = await deps.templates()
    }

    private func readCachedStats() async {
        guard let entry = try? await deps.cache.read(kind: .libraryStats, key: ScheduleCacheKey.libraryStats),
              let decoded = try? JSONDecoder().decode(SearchExercisesResult.self, from: entry.json) else { return }
        index(decoded)
    }

    /// Every definition's stats in one call, archived included, with the
    /// reference counts the web derives from its whole event list.
    public func refreshStats() async {
        do {
            let envelope = try await deps.client.send(
                .query(tool: "search_exercises", args: SearchExercisesResult.args()),
                as: QueryEnvelope<SearchExercisesResult>.self
            )
            index(envelope.result)
            statsUnavailable = false
            if let json = try? JSONEncoder().encode(envelope.result) {
                try? await deps.cache.write(CacheEntry(kind: .libraryStats, key: ScheduleCacheKey.libraryStats, json: json, fetchedAt: deps.clock.now))
            }
        } catch {
            if stats.isEmpty { statsUnavailable = true }
        }
    }

    private func index(_ result: SearchExercisesResult) {
        var next: [String: SearchExercisesResult.Entry] = [:]
        for entry in result.exercises {
            if let id = entry.id { next[id] = entry }
        }
        stats = next
    }

    // MARK: - The list

    /// `LibraryView.tsx`: category, then the needle over name, aliases and
    /// muscle groups; sorted by name; split on archive state.
    private var matching: [ExerciseDefinition] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return definitions
            .filter { category == "all" || $0.category == category }
            .filter { definition in
                guard !needle.isEmpty else { return true }
                if definition.canonicalName.lowercased().contains(needle) { return true }
                if (definition.aliases ?? []).contains(where: { $0.lowercased().contains(needle) }) { return true }
                return (definition.muscleGroups ?? []).contains(where: { $0.lowercased().contains(needle) })
            }
            .sorted { $0.canonicalName.localizedStandardCompare($1.canonicalName) == .orderedAscending }
    }

    public var active: [ExerciseDefinition] { matching.filter { $0.archivedAt == nil } }
    public var archived: [ExerciseDefinition] { matching.filter { $0.archivedAt != nil } }

    public func definition(id: String) -> ExerciseDefinition? {
        definitions.first { $0.id == id }
    }

    /// "Last: Sep 22" · "Never logged" — blank while the stats are unknown.
    public func lastPerformedLabel(_ definition: ExerciseDefinition) -> String? {
        guard let entry = stats[definition.id] else { return nil }
        guard let last = entry.lastPerformed, let day = DayKey(last) else { return "Never logged" }
        return "Last: \(Self.shortDate(day))"
    }

    /// "in 3 workouts" · "unused" — blank while the stats are unknown.
    public func referencesLabel(_ definition: ExerciseDefinition) -> String? {
        guard let count = stats[definition.id]?.references else { return nil }
        return Self.referencesText(count)
    }

    public func referenceCount(_ definition: ExerciseDefinition) -> Int? {
        stats[definition.id]?.references
    }

    public static func referencesText(_ count: Int) -> String {
        count > 0 ? "in \(count) workout\(count == 1 ? "" : "s")" : "unused"
    }

    /// "Sep 22" (`format(d, 'MMM d')`).
    public static func shortDate(_ day: DayKey) -> String {
        "\(MonthNames.short[day.month - 1]) \(day.day)"
    }

    /// "Tue Sep 22, 2026" (`format(d, 'EEE MMM d, yyyy')`).
    public static func sessionDate(_ day: DayKey) -> String {
        "\(MonthNames.weekdayShort[day.weekday - 1]) \(MonthNames.short[day.month - 1]) \(day.day), \(day.year)"
    }

    // MARK: - History

    public enum HistoryOutcome: Sendable, Equatable {
        /// The server's stats for the exercise.
        case history(ExerciseHistoryResult)
        /// Nothing logged under any of its spellings (the tool's 400).
        case none
        case failed(String)
    }

    /// True until the history for this name has been fetched — a rename
    /// changes the name and forgets the old answer.
    public func needsHistoryReload(for definition: ExerciseDefinition) -> Bool {
        histories[definition.canonicalName] == nil
    }

    /// `get_exercise_history` by the canonical name — alias-aware on the
    /// server — memoised for the session; a rename or a new session refetches.
    public func history(for definition: ExerciseDefinition) async -> HistoryOutcome {
        if let known = histories[definition.canonicalName] { return known }
        let outcome: HistoryOutcome
        do {
            let envelope = try await deps.client.send(
                .query(tool: "get_exercise_history", args: ExerciseHistoryResult.args(exerciseName: definition.canonicalName)),
                as: QueryEnvelope<ExerciseHistoryResult>.self
            )
            outcome = .history(envelope.result)
        } catch let error as APIError {
            if case .server(400, _) = error { outcome = .none } else { outcome = .failed(Failure.message(error)) }
        } catch {
            outcome = .failed(Failure.message(error))
        }
        histories[definition.canonicalName] = outcome
        return outcome
    }

    // MARK: - Writes

    /// The editor's Save: only the changed columns. nil = saved (or nothing
    /// to save); a message = the refusal the sheet shows inline.
    public func save(_ definition: ExerciseDefinition, form: DefinitionForm) async -> String? {
        let fields = form.changedFields(against: definition)
        guard !fields.isEmpty else { return nil }
        let name = form.isRenaming(definition) ? form.trimmedName : definition.canonicalName
        do {
            _ = try await deps.client.data(for: .updateDefinition(id: definition.id, fields: fields, name: definition.canonicalName))
        } catch {
            return Failure.message(error)
        }
        histories[definition.canonicalName] = nil
        pendingNotice = "Updated “\(name)”"
        await afterDefinitionWrite()
        return nil
    }

    /// Archive (a timestamp) or restore (null), as the web's editor toggles it.
    public func setArchived(_ definition: ExerciseDefinition, _ archived: Bool) async -> String? {
        let stamp: JSONValue = archived ? .string(CompletionRows.isoTimestamp(deps.clock.now)) : .null
        do {
            _ = try await deps.client.data(for: .updateDefinition(id: definition.id, fields: ["archived_at": stamp], name: definition.canonicalName))
        } catch {
            return Failure.message(error)
        }
        pendingNotice = archived ? "Archived — existing workouts keep it" : "Restored to the library"
        await afterDefinitionWrite()
        return nil
    }

    private func afterDefinitionWrite() async {
        await deps.refreshSchedule()
        await reload()
    }

    /// The screen under a closed sheet posts what the sheet could not.
    public func flushNotice() {
        guard let notice = pendingNotice else { return }
        pendingNotice = nil
        ToastBus.shared.post(notice, level: .success)
    }

    // MARK: - Workout library

    public var activeTemplates: [WorkoutTemplate] {
        templates.filter { $0.archivedAt == nil }.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
    }

    public var archivedTemplates: [WorkoutTemplate] {
        templates.filter { $0.archivedAt != nil }.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
    }

    /// "3 exercises · 45 min" (`TemplateSearch.tsx`).
    public static func templateMeta(_ template: WorkoutTemplate) -> String {
        let count = (template.warmup?.count ?? 0) + (template.exercises?.count ?? 0) + (template.cooldown?.count ?? 0)
        var parts: [String] = []
        if count > 0 { parts.append("\(count) exercise\(count == 1 ? "" : "s")") }
        if let minutes = template.estimatedDuration { parts.append(TimeLabel.duration(minutes: minutes)) }
        return parts.joined(separator: " · ")
    }

    /// A pushed screen, so the schedule's own toasts are visible here.
    public func archiveTemplate(_ template: WorkoutTemplate, archived: Bool) async {
        guard await deps.archiveTemplate(template.id, archived) else { return }
        templates = await deps.templates()
        ToastBus.shared.post(archived ? "Removed from the library" : "Restored to the library", level: .success)
    }
}
