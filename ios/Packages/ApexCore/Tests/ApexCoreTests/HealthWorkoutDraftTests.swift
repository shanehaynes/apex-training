import XCTest
@testable import ApexCore

/// W16 M1: what a finished tracker session becomes in Apple Health. The
/// HealthKit write lives in ApexHealth; the decisions are proved here.
final class HealthWorkoutDraftTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_790_078_400)
    private var end: Date { start.addingTimeInterval(45 * 60) }

    private func event(type: String, sport: String? = nil, id: String = "w1__2026-09-22", title: String = "Upper Body") throws -> ScheduleEvent {
        var base: [String: Any] = ["id": "w1", "type": type, "title": title, "date": "2026-09-22"]
        if let sport { base["sport"] = sport }
        let decoded = try JSONDecoder().decode(WorkoutEventBase.self, from: JSONSerialization.data(withJSONObject: base))
        return try XCTUnwrap(ScheduleEvent(occurrence: Occurrence(id: id, baseId: "w1", date: "2026-09-22"), base: decoded))
    }

    private func group(_ section: String, cardio: Bool) -> TrackedSectionGroup {
        TrackedSectionGroup(section: section, label: section, exercises: [
            TrackedExercise(section: section, exercise: Exercise(id: "x-\(section)", name: "Move"), isCardio: cardio, sets: []),
        ])
    }

    func testEveryTypeAndSportMapsToAHealthActivity() {
        let cases: [(WorkoutType, String?, Bool, HealthActivityKind)] = [
            (.weights, nil, false, .traditionalStrengthTraining),
            (.weights, nil, true, .functionalStrengthTraining),
            (.climbing, nil, false, .climbing),
            (.outdoorClimbing, "climbing", false, .climbing),
            (.cardio, "running", false, .running),
            (.cardio, "biking", false, .cycling),
            (.cardio, "swimming", false, .swimming),
            (.cardio, "climbing", false, .climbing),
            (.cardio, "other", false, .mixedCardio),
            (.cardio, nil, false, .mixedCardio),
            (.cardio, "rowing", false, .mixedCardio),
            (.yoga, nil, false, .yoga),
            (.stretching, nil, false, .flexibility),
            (.morningRoutine, nil, false, .flexibility),
            (.unknown("surfing"), nil, false, .other),
        ]
        for (type, sport, cardio, expected) in cases {
            XCTAssertEqual(HealthActivityKind.forWorkout(type: type, sport: sport, hasMainCardio: cardio), expected, "\(type.rawValue)/\(sport ?? "nil")/\(cardio)")
        }
    }

    func testOnlyMainWorkCardioMakesStrengthFunctional() throws {
        let weights = try event(type: "weights")
        let warmupRow = HealthWorkoutDraft(event: weights, groups: [group("warmup", cardio: true), group("exercise", cardio: false)], startedAt: start, finishedAt: end)
        XCTAssertEqual(warmupRow?.kind, .traditionalStrengthTraining, "a rowing warm-up does not change what the session was")
        let mainRow = HealthWorkoutDraft(event: weights, groups: [group("exercise", cardio: true)], startedAt: start, finishedAt: end)
        XCTAssertEqual(mainRow?.kind, .functionalStrengthTraining)
    }

    func testDraftCarriesTheRealInstantsTitleAndSession() throws {
        let draft = try XCTUnwrap(HealthWorkoutDraft(event: try event(type: "cardio", sport: "running", title: "Tempo Run"), groups: [], startedAt: start, finishedAt: end))
        XCTAssertEqual(draft.start, start)
        XCTAssertEqual(draft.end, end)
        XCTAssertEqual(draft.title, "Tempo Run")
        XCTAssertEqual(draft.kind, .running)
        XCTAssertEqual(draft.session, SessionKey(eventId: "w1__2026-09-22", eventDate: "2026-09-22"))
    }

    func testSyncIdentifierIsTheOccurrenceAndVersionIsTheFinishSecond() throws {
        let draft = try XCTUnwrap(HealthWorkoutDraft(event: try event(type: "weights"), groups: [], startedAt: start, finishedAt: end))
        XCTAssertEqual(draft.syncIdentifier, "apex:w1__2026-09-22|2026-09-22")
        XCTAssertEqual(draft.syncIdentifier, HealthWorkoutDraft.syncIdentifier(for: draft.session), "cancel deletes by the same key")
        XCTAssertEqual(draft.syncVersion, Int(end.timeIntervalSince1970))
        let later = try XCTUnwrap(HealthWorkoutDraft(event: try event(type: "weights"), groups: [], startedAt: start, finishedAt: end.addingTimeInterval(90)))
        XCTAssertGreaterThan(later.syncVersion, draft.syncVersion, "a re-finish replaces, never loses to, the earlier save")
    }

    func testNoDraftWithoutAStartOrWithAnEmptySpan() throws {
        let weights = try event(type: "weights")
        XCTAssertNil(HealthWorkoutDraft(event: weights, groups: [], startedAt: nil, finishedAt: end), "no measured start, nothing true to write")
        XCTAssertNil(HealthWorkoutDraft(event: weights, groups: [], startedAt: end, finishedAt: end))
        XCTAssertNil(HealthWorkoutDraft(event: weights, groups: [], startedAt: end, finishedAt: start))
    }
}
