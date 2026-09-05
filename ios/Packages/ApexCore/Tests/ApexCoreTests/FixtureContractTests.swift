import XCTest
@testable import ApexCore

/// Decodes every committed fixture. The fixtures are written by the web repo's
/// integration suite (api/__tests__/integration/ios-read.integration.test.ts), so
/// this is the contract between the two clients: if the server changes a shape,
/// the emitter rewrites the JSON and this test fails on the next Swift run.
final class FixtureContractTests: XCTestCase {
    /// `ios/Fixtures/` sits outside the package, and SwiftPM refuses resources
    /// outside a target directory. `#filePath` is the dependency-free way there,
    /// and works under both `swift test` and `xcodebuild test`.
    private static let fixtures: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ApexCoreTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // ApexCore
        .deletingLastPathComponent()  // Packages
        .deletingLastPathComponent()  // ios
        .appendingPathComponent("Fixtures")

    private func load(_ name: String) throws -> Data {
        let url = Self.fixtures.appendingPathComponent(name)
        return try Data(contentsOf: url)
    }

    private func decode<T: Decodable>(_ type: T.Type, from name: String) throws -> T {
        try JSONDecoder().decode(type, from: try load(name))
    }

    func testScheduleDecodes() throws {
        let schedule = try decode(ScheduleResponse.self, from: "schedule.json")
        XCTAssertEqual(schedule.window.start, "2026-09-01")
        // The weekly series plus three one-offs on 2026-09-08.
        XCTAssertEqual(schedule.bases.count, 4)
        let weekly = try XCTUnwrap(schedule.bases.first { $0.id == "ios-fixture-weekly" })
        XCTAssertEqual(weekly.type, .weights)
        XCTAssertEqual(schedule.occurrences.count, 8)
        XCTAssertEqual(schedule.definitions?.first?.canonicalName, "Fixture Press")

        // The recurring occurrence id is `${baseId}__${date}` — the OccurrenceID
        // shape the whole app keys off — and the series anchor's own occurrence
        // carries the bare base id.
        let mine = schedule.occurrences.filter { $0.baseId == "ios-fixture-weekly" }
        XCTAssertEqual(mine[0].id, "ios-fixture-weekly")
        XCTAssertEqual(mine[1].id, "ios-fixture-weekly__2026-09-08")
        XCTAssertEqual(OccurrenceID.date(of: mine[1].id), mine[1].date)
    }

    /// Every field the event sheet renders, on the base that carries it.
    func testScheduleCarriesTheEventSheetFields() throws {
        let schedule = try decode(ScheduleResponse.self, from: "schedule.json")
        let run = try XCTUnwrap(schedule.bases.first { $0.id == "ios-fixture-run" })
        XCTAssertEqual(run.type, .cardio)
        XCTAssertEqual(run.sport, "running")
        XCTAssertEqual(run.subtitle, "Zone 2")
        XCTAssertEqual(run.location, "East Rock")
        XCTAssertEqual(run.cardioTargets?.distance, "5 mi")
        XCTAssertEqual(run.cardioTargets?.avgHeartRate, 150)

        let crag = try XCTUnwrap(schedule.bases.first { $0.id == "ios-fixture-crag" })
        XCTAssertEqual(crag.type, .outdoorClimbing)
        XCTAssertEqual(crag.climbingTargets?.maxGrade, "5.11a")
        XCTAssertEqual(crag.climbingTargets?.totalPitches, 4)
        XCTAssertEqual(crag.warmup?.count, 1)
        let pitch = try XCTUnwrap(crag.exercises?.first)
        XCTAssertEqual(pitch.climbStyle, "sport")
        XCTAssertEqual(pitch.grade, "5.10c")
        XCTAssertEqual(pitch.ascentStyle, "redpoint")

        let circuit = try XCTUnwrap(schedule.bases.first { $0.id == "ios-fixture-circuit" })
        XCTAssertEqual(circuit.exercises?.map(\.superset), ["A", "A", nil])
        XCTAssertEqual(circuit.exercises?[0].plannedSets?.count, 3)
        XCTAssertEqual(circuit.exercises?[0].plannedSets?[1].targetWeight, "165 lb")

        // Indexed: four events on the day, in start-time order, one completed.
        let index = ScheduleIndex(schedule)
        let day = index.events(on: DayKey("2026-09-08")!)
        XCTAssertEqual(day.map(\.id), ["ios-fixture-run", "ios-fixture-crag", "ios-fixture-circuit", "ios-fixture-weekly__2026-09-08"])
        XCTAssertEqual(day.filter(\.isCompleted).map(\.id), ["ios-fixture-weekly__2026-09-08"])
    }

    func testEmptyWindowDecodes() throws {
        let schedule = try decode(ScheduleResponse.self, from: "schedule-empty.json")
        XCTAssertEqual(schedule.window.start, "2026-10-28")
        XCTAssertTrue(schedule.bases.isEmpty)
        XCTAssertTrue(schedule.occurrences.isEmpty)
        XCTAssertTrue(ScheduleIndex(schedule).isEmpty)
    }

    func testActivityStreamsDecode() throws {
        let rows = try decode([ActivityStreamRecord].self, from: "activity-streams.json")
        let record = try XCTUnwrap(rows.first)
        XCTAssertEqual(record.provider, "coros")
        XCTAssertEqual(record.hrSamples.count, 5)
        XCTAssertEqual(record.gpsSamples.count, 5)
        XCTAssertEqual(record.gpsSamples[2].elevationMeters, 80)
        XCTAssertEqual(SyncMetricsFormatter.items(record.summary).map(\.text),
                       ["150/172 bpm", "5.00 mi", "800 ft", "420 cal", "Load 88"])
    }

    func testMealsQueryDecodes() throws {
        let meals = try decode(QueryEnvelope<MealsQueryResult>.self, from: "query-get_meals.json")
        XCTAssertEqual(meals.tool, "get_meals")
        let day = try XCTUnwrap(meals.result.days.first)
        XCTAssertEqual(day.date, "2026-09-08")
        XCTAssertEqual(day.mealCount, 2)
        XCTAssertEqual(day.totals.calories, 1114)
        XCTAssertEqual(day.totals.proteinG, 70)
        XCTAssertEqual(day.meals?.map(\.title), ["Fixture Oats", "Fixture Chicken Bowl"])
        // The server derived this one (no stored calories): Atwater 4/4/9.
        XCTAssertEqual(day.meals?[1].calories, 594)
        XCTAssertEqual(day.meals?[1].mealType, "lunch")
    }

    /// The emitter normalises volatile values to the literal strings "<uuid>" and
    /// "<timestamp>" so the committed JSON is stable. Those fields must therefore
    /// stay `String` in Swift. If someone "improves" a model to `UUID` or `Date`,
    /// this fails immediately with an obvious message instead of blowing up in
    /// production against real data.
    func testVolatileFieldsAreStrings() throws {
        let schedule = try decode(ScheduleResponse.self, from: "schedule.json")
        let done = try XCTUnwrap(schedule.occurrences.first { $0.id == "ios-fixture-weekly__2026-09-08" })
        XCTAssertEqual(done.completedAt, "<timestamp>")

        let bootstrap = try decode(TrackerBootstrap.self, from: "bootstrap.json")
        XCTAssertEqual(bootstrap.session?.id, "<uuid>")
        XCTAssertEqual(bootstrap.session?.userId, "<uuid>")
        XCTAssertEqual(bootstrap.session?.startedAt, "<timestamp>")

        let profile = try decode(ProfileResponse.self, from: "profile.json")
        XCTAssertEqual(profile.termsAccepted?.acceptedAt, "<timestamp>")
    }

    /// `session` is a snake_case DB row; `event` and `groups` are camelCase API
    /// shapes. One decoder, both casings — which is why the models spell out
    /// CodingKeys instead of using a global key strategy.
    func testBootstrapDecodesMixedCasing() throws {
        let bootstrap = try decode(TrackerBootstrap.self, from: "bootstrap.json")
        XCTAssertEqual(bootstrap.session?.eventId, "ios-fixture-weekly__2026-09-22")
        XCTAssertEqual(bootstrap.session?.totalDurationSeconds, 1800)
        XCTAssertEqual(bootstrap.event?.title, "Fixture Push Day")
        XCTAssertEqual(bootstrap.event?.estimatedDuration, 60)

        let group = try XCTUnwrap(bootstrap.groups.first)
        XCTAssertEqual(group.label, "Main Work")
        XCTAssertEqual(group.exercises.count, 2)

        let press = group.exercises[0]
        XCTAssertFalse(press.isCardio)
        XCTAssertEqual(press.sets.count, 2)
        XCTAssertTrue(press.sets[0].isLogged)
        XCTAssertEqual(press.sets[0].actualWeight, "120 lb")
        XCTAssertEqual(press.sets[1].shadow?.weight, "110 lb")

        let row = group.exercises[1]
        XCTAssertTrue(row.isCardio)
        XCTAssertTrue(row.sets.isEmpty)
        XCTAssertEqual(row.cardio?.isLogged, false)
    }

    /// `peek: true` reads the model without creating the session: the plan and
    /// shadows come back, `session` is null, and nothing is stamped.
    func testPeekBootstrapDecodesWithoutASession() throws {
        let peek = try decode(TrackerBootstrap.self, from: "bootstrap-peek.json")
        XCTAssertNil(peek.session)
        XCTAssertEqual(peek.event?.title, "Fixture Push Day")
        XCTAssertEqual(peek.groups.count, 1)
        XCTAssertEqual(peek.prs, [])
        XCTAssertNil(peek.scoreRecord)
        let press = peek.groups[0].exercises[0]
        XCTAssertEqual(press.sets.map(\.isLogged), [false, false])
        XCTAssertEqual(press.sets[0].shadow?.weight, "100 lb")
        XCTAssertEqual(press.sets[1].shadow?.weight, "110 lb")
    }

    /// The workout summary is the coach wire with no tools: text deltas then done.
    func testCoachSummaryStreamDecodes() throws {
        var parser = NDJSONLineParser()
        var events: [ChatWireEvent] = []
        for line in parser.consume(try load("coach-summary.ndjson")) + parser.finish() {
            events.append(try JSONDecoder().decode(ChatWireEvent.self, from: Data(line.utf8)))
        }
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0], .text(delta: "Strong session — "))
        XCTAssertEqual(events[1], .text(delta: "a new estimated 1RM on Fixture Press."))
        XCTAssertEqual(events[2], .done)
    }

    func testFinishDecodes() throws {
        let finish = try decode(FinishResponse.self, from: "finish.json")
        XCTAssertTrue(finish.ok)
        XCTAssertEqual(finish.totalDurationSeconds, 1800)
        XCTAssertEqual(finish.prs.count, 1)
        XCTAssertEqual(finish.prs[0].kind, "oneRM")
        XCTAssertEqual(finish.prs[0].exerciseName, "Fixture Press")
        XCTAssertNotNil(finish.recap)
    }

    func testProfileDecodes() throws {
        let profile = try decode(ProfileResponse.self, from: "profile.json")
        XCTAssertFalse(profile.hasAnthropicKey)
        XCTAssertNil(profile.anthropicKeyLast4)
        XCTAssertTrue(profile.termsCurrent)
    }

    func testQueryEnvelopesDecode() throws {
        struct PRs: Codable, Sendable, Equatable {
            let scope: String
            let lifts: [Lift]
            struct Lift: Codable, Sendable, Equatable {
                let exercise: String
                let estimated_1rm: Double
                let weight: Double
                let reps: Int
                let date: String
            }
        }
        let prs = try decode(QueryEnvelope<PRs>.self, from: "query-get_prs.json")
        XCTAssertEqual(prs.tool, "get_prs")
        XCTAssertEqual(prs.result.lifts.first?.exercise, "Fixture Press")

        // Only the envelope is asserted here: the per-tool result shapes belong
        // to the features that consume them (W6/W9).
        struct AnyResult: Codable, Sendable, Equatable {}
        _ = try decode(QueryEnvelope<AnyResult>.self, from: "query-search_exercises.json")
    }

    func testAnalyticsComputeDecodes() throws {
        let analytics = try decode(AnalyticsComputeResponse.self, from: "analytics-compute.json")
        XCTAssertEqual(analytics.today, "2026-09-22")
        XCTAssertEqual(analytics.tiles.count, 3)

        guard case .ok(let first) = analytics.tiles[0] else {
            return XCTFail("first tile should have computed")
        }
        XCTAssertEqual(first.series.first?.label, "Sessions")
        XCTAssertEqual(first.series.first?.points, [1])

        // A tile that could not compute carries a reason, not an exception.
        guard case .problem(let problem) = analytics.tiles[2] else {
            return XCTFail("third tile should be a problem")
        }
        XCTAssertFalse(problem.isEmpty)
    }

    func testCoachToolDecodes() throws {
        let response = try decode(CoachToolResponse.self, from: "coach-tool.json")
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.resultText?.isEmpty, false)
    }

    /// The coach stream, parsed exactly the way the app will: bytes → lines →
    /// one wire event per line.
    func testChatStreamDecodes() throws {
        var parser = NDJSONLineParser()
        var events: [ChatWireEvent] = []
        for line in parser.consume(try load("chat-stream.ndjson")) + parser.finish() {
            events.append(try JSONDecoder().decode(ChatWireEvent.self, from: Data(line.utf8)))
        }

        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0], .text(delta: "Clearing it. "))
        guard case .toolUse(let id, let name, let input, let label) = events[1] else {
            return XCTFail("second event should be a tool_use")
        }
        XCTAssertEqual(id, "toolu_fixture")
        XCTAssertEqual(name, "delete_event")
        // The label is server-built and shown verbatim on the confirmation card.
        XCTAssertEqual(label, "Delete: Fixture Push Day · 2026-09-29 (this instance)")
        let decoded = try JSONSerialization.jsonObject(with: input) as? [String: Any]
        XCTAssertEqual(decoded?["scope"] as? String, "instance")
        XCTAssertEqual(events[2], .done)
    }
}
