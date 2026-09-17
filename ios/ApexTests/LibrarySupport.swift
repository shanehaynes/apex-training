import ApexCore
import ApexFeatures
import Foundation

/// What the app hands the Library (W10), recorded: the schedule's cached
/// lists, how often a write asked for a refresh, and the template archives
/// delegated to the schedule.
@MainActor
final class LibraryHooks {
    var definitions: [ExerciseDefinition]
    var templates: [WorkoutTemplate]
    var refreshes = 0
    var archived: [(id: String, archived: Bool)] = []

    init(definitions: [ExerciseDefinition], templates: [WorkoutTemplate]) {
        self.definitions = definitions
        self.templates = templates
    }
}

/// The fixture's definition and template, plus two more definitions so the
/// list has something to filter and an archived row to split off.
@MainActor
func libraryFixtures() -> (definitions: [ExerciseDefinition], templates: [WorkoutTemplate]) {
    let schedule = try! JSONDecoder().decode(ScheduleResponse.self, from: CoachTransport.fixture("schedule.json"))
    let extra = [
        ExerciseDefinition(id: "cable-row", canonicalName: "Cable Row", aliases: ["Seated Row"], category: "strength", muscleGroups: ["back"], equipment: ["cable"], isUnilateral: false),
        ExerciseDefinition(id: "old-jog", canonicalName: "Old Jog", aliases: [], category: "cardio", muscleGroups: [], equipment: [], isUnilateral: false, archivedAt: "2026-08-01T00:00:00Z"),
    ]
    return ((schedule.definitions ?? []) + extra, schedule.templates ?? [])
}

extension YouTransport {
    /// Every Library route answered from its fixture.
    static func library() -> YouTransport {
        let t = YouTransport()
        t.set("POST /api/query search_exercises", .json(200, fixture("query-search_exercises.json")))
        t.set("POST /api/query get_exercise_history", .json(200, fixture("query-get_exercise_history.json")))
        t.set("PATCH /api/exercise-definitions", .json(200, Data(#"{"ok":true}"#.utf8)))
        return t
    }
}

@MainActor
func makeLibraryModel(_ transport: YouTransport, hooks: LibraryHooks, cache: any CacheStore = MemoryCacheStore()) -> LibraryModel {
    let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
    return LibraryModel(deps: LibraryDependencies(
        client: client, cache: cache, clock: TestClock(now: coachTestNow),
        definitions: { hooks.definitions },
        templates: { hooks.templates },
        refreshSchedule: { hooks.refreshes += 1 },
        archiveTemplate: { id, archived in
            hooks.archived.append((id, archived))
            hooks.templates = hooks.templates.map { template in
                guard template.id == id else { return template }
                return WorkoutTemplate(id: template.id, title: template.title, type: template.type, archivedAt: archived ? "2026-09-08T12:00:00Z" : nil, updatedAt: template.updatedAt)
            }
            return true
        }
    ))
}
