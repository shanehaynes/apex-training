import ApexCore
import ApexFeatures
import ApexHealth
import XCTest

/// W16 M1: the publisher's gates (the user's choice, Health's permission),
/// the per-account choice, and the You → Apple Health model, all over the
/// in-memory store — CI's simulator has no entitlement and no Health data.
final class HealthTests: XCTestCase {
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "apex.tests.health.\(UUID().uuidString)"
    }

    override func tearDown() {
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func preferences(_ owner: String = "user-a") -> HealthPreferences {
        HealthPreferences(owner: owner, suiteName: suite)
    }

    private func draft(_ eventId: String = "w1__2026-09-22", end: TimeInterval = 2700) -> HealthWorkoutDraft {
        let start = Date(timeIntervalSince1970: 1_790_078_400)
        return HealthWorkoutDraft(
            session: SessionKey(eventId: eventId, eventDate: "2026-09-22"), kind: .traditionalStrengthTraining,
            title: "Upper Body", startedAt: start, finishedAt: start.addingTimeInterval(end)
        )!
    }

    // MARK: - Publisher

    func testNothingIsWrittenUntilTheUserTurnsItOn() async {
        let store = FakeHealthStore(authorization: .authorized)
        let prefs = preferences()
        let publisher = HealthWorkoutPublisher(store: store, preferences: prefs)
        await publisher.workoutFinished(draft())
        XCTAssertTrue(store.saved.isEmpty, "off by default")

        prefs.setWritesWorkouts(true)
        await publisher.workoutFinished(draft())
        XCTAssertEqual(store.saved, [draft()])
    }

    func testHealthsRefusalWins() async {
        let prefs = preferences()
        prefs.setWritesWorkouts(true)
        for state in [HealthAuthorization.denied, .notDetermined, .unavailable] {
            let store = FakeHealthStore(authorization: state)
            await HealthWorkoutPublisher(store: store, preferences: prefs).workoutFinished(draft())
            XCTAssertTrue(store.saved.isEmpty, "\(state)")
        }
    }

    func testAReFinishReplacesAndACancelRemovesEvenWithWritingOff() async {
        let store = FakeHealthStore(authorization: .authorized)
        let prefs = preferences()
        prefs.setWritesWorkouts(true)
        let publisher = HealthWorkoutPublisher(store: store, preferences: prefs)
        await publisher.workoutFinished(draft())
        await publisher.workoutFinished(draft(end: 3000))
        await publisher.workoutFinished(draft("w2__2026-09-22"))
        XCTAssertEqual(store.saved.count, 2, "one workout per occurrence")

        prefs.setWritesWorkouts(false)
        await publisher.workoutCancelled(SessionKey(eventId: "w1__2026-09-22", eventDate: "2026-09-22"))
        XCTAssertEqual(store.saved.map(\.session.eventId), ["w2__2026-09-22"], "what Apex wrote goes with its session")
    }

    func testTheChoiceBelongsToOneAccount() {
        preferences("user-a").setWritesWorkouts(true)
        XCTAssertTrue(preferences("user-a").writesWorkouts)
        XCTAssertFalse(preferences("user-b").writesWorkouts, "a second account on the phone starts off")
    }

    // MARK: - You → Apple Health

    @MainActor
    func testTurningItOnAsksHealthOnceAndKeepsTheChoice() async {
        let store = FakeHealthStore()
        let model = HealthModel(services: HealthServices(store: store, preferences: preferences()))
        XCTAssertEqual(model.statusLabel, "Off")
        await model.setWritesWorkouts(true)
        XCTAssertEqual(store.requestCount, 1)
        XCTAssertTrue(model.writesWorkouts)
        XCTAssertEqual(model.statusLabel, "Writing workouts")

        await model.setWritesWorkouts(false)
        XCTAssertEqual(store.requestCount, 1, "turning it off asks nothing")
        XCTAssertEqual(model.statusLabel, "Off")
    }

    @MainActor
    func testARefusalKeepsTheChoiceAndSaysWhere() async {
        let store = FakeHealthStore(grantOnRequest: false)
        let model = HealthModel(services: HealthServices(store: store, preferences: preferences()))
        await model.setWritesWorkouts(true)
        XCTAssertTrue(model.writesWorkouts, "allowing Apex later in Health is all it takes")
        XCTAssertTrue(model.isDenied)
        XCTAssertEqual(model.statusLabel, "Denied in Health")

        store.setAuthorization(.authorized)
        model.refresh()
        XCTAssertEqual(model.statusLabel, "Writing workouts", "re-read when the screen appears")
    }

    @MainActor
    func testNoHealthStoreSaysSo() {
        let model = HealthModel(services: HealthServices(store: FakeHealthStore(authorization: .unavailable), preferences: preferences()))
        XCTAssertFalse(model.isAvailable)
        XCTAssertEqual(model.statusLabel, "Not available")
    }
}
