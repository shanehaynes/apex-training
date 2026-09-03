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
        XCTAssertEqual(schedule.bases.count, 1)
        XCTAssertEqual(schedule.bases[0].type, .weights)
        XCTAssertEqual(schedule.occurrences.count, 5)
        XCTAssertEqual(schedule.definitions?.first?.canonicalName, "Fixture Press")

        // The recurring occurrence id is `${baseId}__${date}` — the OccurrenceID
        // shape the whole app keys off.
        XCTAssertEqual(schedule.occurrences[1].id, "ios-fixture-weekly__2026-09-08")
        XCTAssertEqual(schedule.occurrences[1].baseId, "ios-fixture-weekly")
    }

    /// The emitter normalises volatile values to the literal strings "<uuid>" and
    /// "<timestamp>" so the committed JSON is stable. Those fields must therefore
    /// stay `String` in Swift. If someone "improves" a model to `UUID` or `Date`,
    /// this fails immediately with an obvious message instead of blowing up in
    /// production against real data.
    func testVolatileFieldsAreStrings() throws {
        let schedule = try decode(ScheduleResponse.self, from: "schedule.json")
        XCTAssertEqual(schedule.occurrences[1].completedAt, "<timestamp>")

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
