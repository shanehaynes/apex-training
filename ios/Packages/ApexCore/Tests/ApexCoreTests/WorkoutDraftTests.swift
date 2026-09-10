import XCTest
@testable import ApexCore

/// `src/lib/builder/__tests__/draft.test.ts` — the form-state half the phone
/// keeps (constructors, `withType`, the instant problem) plus the acceptance
/// line from the brief: the draft JSON round-trips through the server
/// reducer's fixture without losing a key.
final class WorkoutDraftTests: XCTestCase {
    private let template = WorkoutTemplate(
        id: "wt-1", title: "CINDY", type: .weights, scoringType: "amrap", timeCapMinutes: 20, estimatedDuration: 30,
        difficulty: 4, description: "5 pull-ups, 10 push-ups, 15 squats", warmup: [],
        exercises: [Exercise(id: "ex-1", name: "Pull-up", category: "strength", reps: "5")], cooldown: [],
        tags: ["benchmark"], equipment: []
    )

    func testStartsAsAStrengthWeightsDraftOnTheGivenDate() {
        let draft = WorkoutDraft.empty(date: "2026-08-28", title: "Test")
        XCTAssertEqual(draft.type, .weights)
        XCTAssertEqual(draft.scoringType, "strength")
        XCTAssertEqual(draft.date, "2026-08-28")
        XCTAssertEqual(draft.title, "Test")
        XCTAssertEqual(draft.duration, "60")
        XCTAssertEqual(draft.difficulty, 3)
        XCTAssertEqual(draft.repeatRule, .off)
        XCTAssertNil(draft.templateId)
    }

    func testWithTypeFollowsDefaultTitleAndDurationPreservesCustomizedOnes() {
        let fresh = WorkoutDraft.empty(date: "2026-08-28").withType(.cardio)
        XCTAssertEqual(fresh.title, "Cardio")
        XCTAssertEqual(fresh.duration, "45")

        var custom = WorkoutDraft.empty(date: "2026-08-28", title: "Hill Repeats")
        custom.duration = "75"
        let kept = custom.withType(.cardio)
        XCTAssertEqual(kept.title, "Hill Repeats")
        XCTAssertEqual(kept.duration, "75")
    }

    func testClimbingTypesForceTheSportAndLeavingThemDropsIt() {
        var draft = WorkoutDraft.empty(date: "2026-08-28").withType(.outdoorClimbing)
        XCTAssertEqual(draft.sport, "climbing")
        draft = draft.withType(.cardio)
        XCTAssertEqual(draft.sport, "")
        draft.sport = "running"
        XCTAssertEqual(draft.withType(.weights).sport, "running")
    }

    func testRequiresATitleAndAPositiveDuration() {
        var draft = WorkoutDraft.empty(date: "2026-08-28")
        XCTAssertEqual(draft.problem, "Give the workout a title")
        draft.title = "Test"
        for duration in ["0", "abc", ""] {
            draft.duration = duration
            XCTAssertEqual(draft.problem, "Duration must be a positive number of minutes", duration)
        }
    }

    func testRequiresATimeCapOnlyForAMRAP() {
        var draft = WorkoutDraft.empty(date: "2026-08-28", title: "Test")
        draft.scoringType = "amrap"
        XCTAssertEqual(draft.problem, "AMRAP needs a time cap in minutes")
        draft.timeCap = "20"
        XCTAssertNil(draft.problem)
        draft.scoringType = "for-time"
        draft.timeCap = ""
        XCTAssertNil(draft.problem)
        draft.repeatRule = DraftRepeat(enabled: true, days: [], interval: "1", until: "")
        XCTAssertEqual(draft.problem, "Pick at least one day to repeat on")
    }

    func testDraftFromTemplateCarriesTheLibraryEntryWithoutPlacement() {
        let draft = WorkoutDraft(template: template, date: "2026-08-28")
        XCTAssertEqual(draft.templateId, "wt-1")
        XCTAssertEqual(draft.title, "CINDY")
        XCTAssertEqual(draft.timeCap, "20")
        XCTAssertEqual(draft.duration, "30")
        XCTAssertEqual(draft.tags, "benchmark")
        XCTAssertEqual(draft.lists.exercises.map(\.name), ["Pull-up"])
        XCTAssertEqual(draft.startTime, "")
        XCTAssertEqual(draft.repeatRule, .off)
    }

    func testDraftFromEventTakesTheOccurrencesDayAndTimesAndTheBasesRule() throws {
        let json = """
        {"window":{"start":"2026-09-01","end":"2026-09-30"},
         "bases":[{"id":"a","type":"cardio","sport":"running","title":"Run","date":"2026-09-01","startTime":"7:00 AM","endTime":"7:45 AM",
                   "estimatedDuration":45,"difficulty":2,"tags":["easy","z2"],"cardioTargets":{"distance":"5 mi","avgHeartRate":150},
                   "exercises":[{"id":"e","name":"Run","category":"cardio"}],"isRecurring":true,"recurrenceRule":"FREQ=WEEKLY;BYDAY=MO,WE"}],
         "occurrences":[{"id":"a__2026-09-16","baseId":"a","date":"2026-09-17","originalDate":"2026-09-16","startTime":"6:00 AM","endTime":null,"isCompleted":false,"completedAt":null}]}
        """
        let index = ScheduleIndex(try JSONDecoder().decode(ScheduleResponse.self, from: Data(json.utf8)))
        let draft = WorkoutDraft(event: try XCTUnwrap(index.event(id: "a__2026-09-16")))
        XCTAssertEqual(draft.date, "2026-09-17")
        XCTAssertEqual(draft.startTime, "06:00")
        // No override on the end: the occurrence shows the base's, and so does the draft.
        XCTAssertEqual(draft.endTime, "07:45")
        XCTAssertEqual(draft.sport, "running")
        XCTAssertEqual(draft.tags, "easy, z2")
        XCTAssertEqual(draft.distance, "5 mi")
        XCTAssertEqual(draft.avgHeartRate, "150")
        XCTAssertEqual(draft.repeatRule, DraftRepeat(enabled: true, days: [.monday, .wednesday], interval: "1", until: ""))
        XCTAssertEqual(draft.lists.exercises.count, 1)
    }

    /// The brief's acceptance line: the reducer's own output decodes, and
    /// what the phone encodes back is the same JSON value — no key lost.
    func testDraftRoundTripsThroughTheServerReducerFixture() throws {
        let response = try TestFixtures.decode(CoachToolResponse.self, "coach-tool-draft.json")
        XCTAssertTrue(response.ok)
        let wire = try XCTUnwrap(response.draft)
        let draft = try WorkoutDraft(jsonValue: wire)
        XCTAssertEqual(draft.title, "Fixture Coach Draft")
        XCTAssertEqual(draft.lists.exercises.first?.definitionId, "ios-fixture-def")
        XCTAssertEqual(draft.repeatRule.days, [.tuesday])
        XCTAssertEqual(try draft.jsonValue(), wire)
        XCTAssertEqual(try WorkoutDraft(jsonValue: try draft.jsonValue()), draft)
    }
}
