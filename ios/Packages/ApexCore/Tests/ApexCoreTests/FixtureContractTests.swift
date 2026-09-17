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
        // W6: the seeded user has no model pick, so the label is the default's.
        XCTAssertNil(profile.coachModel)
        XCTAssertEqual(profile.coachModelLabel, "Opus 5")
    }

    /// A profile cached by a build that predates the coach fields still decodes.
    // MARK: - W11

    /// The profile fixture now carries the whole `profiles` row and the model
    /// catalog, so the You tab reads one endpoint instead of the table.
    func testProfileCarriesTheYouTabFields() throws {
        let profile = try decode(ProfileResponse.self, from: "profile.json")
        XCTAssertEqual(profile.displayName, "agent")
        XCTAssertEqual(profile.avatarKey, "goat")
        // The seeded user has cleared coach text and no zones set.
        XCTAssertEqual(profile.coachGoal, "")
        XCTAssertNil(profile.maxHr)
        // The emitter scrubs the ics_token, so this pins the shape, not a value.
        XCTAssertEqual(profile.calendarFeedUrl, "http://localhost/api/calendar-feed?token=<uuid>")

        let models = try XCTUnwrap(profile.coachModels)
        XCTAssertEqual(models.first?.id, "claude-opus-5")
        XCTAssertEqual(models.first?.priceLabel, "$5/$25 per Mtok")
        XCTAssertEqual(models.map(\.label), ["Opus 5", "Opus 4.8", "Sonnet 5", "Haiku 4.5"])
    }

    // MARK: - W13

    /// The profile carries the onboarding block: the seeded user has dismissed
    /// the flow (the migration stamped existing rows) and has done nothing.
    func testProfileCarriesTheOnboardingState() throws {
        let profile = try decode(ProfileResponse.self, from: "profile.json")
        let onboarding = try XCTUnwrap(profile.onboarding)
        XCTAssertEqual(onboarding.dismissedAt, "<timestamp>")
        XCTAssertTrue(onboarding.applies)
        XCTAssertEqual(onboarding.setup, .init(template: false, key: false, goal: false))
        XCTAssertFalse(onboarding.setup.allDone)
        XCTAssertEqual(onboarding.setup.isDone(.key), false)
        XCTAssertNil(onboarding.setup.isDone(.coros), "the card never answers the two remote rows")
    }

    /// Every source the feed can carry, and both attribution badges.
    func testActivityLogDecodes() throws {
        let log = try decode(ActivityLogResponse.self, from: "mutations-log.json")
        XCTAssertEqual(log.entries.map(\.source), ["event", "event", "definition", "block", "objective"])
        let newest = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(newest.operation, "update_instance")
        XCTAssertEqual(newest.eventDate, "2026-09-09")
        XCTAssertFalse(newest.isUserTriggered)
        XCTAssertTrue(log.entries[1].isUserTriggered)
        // Only events carry a date.
        XCTAssertNil(log.entries[2].eventDate)
    }

    func testConnectorTokensAndConnectedAppsDecode() throws {
        let listed = try decode(McpTokensResponse.self, from: "mcp-tokens.json")
        let token = try XCTUnwrap(listed.tokens.first)
        XCTAssertEqual(token.name, "ios-fixture laptop")
        XCTAssertNil(token.lastUsedAt)
        XCTAssertTrue(token.isActive)
        XCTAssertEqual(listed.activeTokens.count, 1)

        let app = try XCTUnwrap(listed.connections.first)
        XCTAssertEqual(app.clientId, "ios-fixture-client-1")
        XCTAssertEqual(app.id, app.clientId)

        // The one-time reveal. Both values are scrubbed by the emitter.
        let minted = try decode(MintedMcpToken.self, from: "mcp-token-mint.json")
        XCTAssertEqual(minted.token, "<token>")
    }

    func testProviderStatusDecodes() throws {
        let status = try decode(ProviderStatusResponse.self, from: "provider-status.json")
        XCTAssertEqual(status.coros.known, .connected)
        XCTAssertTrue(status.coros.configured)
        XCTAssertTrue(status.coros.autoSync)
        XCTAssertEqual(status.coros.pendingFillCount, 0)
    }

    /// The proposal list is what the confirmation queue walks: a matched
    /// activity asks, an unmatched one imports without asking.
    func testSyncPreviewAndApplyDecode() throws {
        let preview = try decode(SyncPreviewResponse.self, from: "provider-preview.json")
        XCTAssertEqual(preview.proposals.count, 2)

        let fill = try XCTUnwrap(preview.proposals.first)
        XCTAssertTrue(fill.needsConfirmation)
        XCTAssertEqual(fill.activity.id, fill.activity.activityId)
        // Quantities arrive pre-formatted with units — never a bare number.
        XCTAssertEqual(fill.activity.distance, "5.20 mi")
        XCTAssertEqual(try XCTUnwrap(fill.match).eventId, "ios-fixture-planned-run")

        let create = preview.proposals[1]
        XCTAssertFalse(create.needsConfirmation)
        XCTAssertNil(create.match)

        let outcome = try decode(SyncApplyOutcome.self, from: "provider-apply.json")
        XCTAssertEqual(outcome.created, 1)
        XCTAssertEqual(outcome.filled, 1)
        XCTAssertTrue(outcome.errors.isEmpty)
    }

    func testProfileWithoutCoachFieldsDecodes() throws {
        let legacy = #"{"hasAnthropicKey":true,"anthropicKeyLast4":"abcd","termsAccepted":null,"termsCurrent":true}"#
        let profile = try JSONDecoder().decode(ProfileResponse.self, from: Data(legacy.utf8))
        XCTAssertTrue(profile.hasAnthropicKey)
        XCTAssertNil(profile.coachModelLabel)
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
        // The six seeded tiles in dashboard order, then a spec the engine refuses.
        XCTAssertEqual(analytics.tiles.count, 7)

        guard case .ok(let sessions) = analytics.tiles[0] else { return XCTFail("the KPI should have computed") }
        XCTAssertEqual(sessions.series.first?.label, "Sessions")
        XCTAssertEqual(sessions.series.first?.points, [1])
        XCTAssertEqual(sessions.buckets.map(\.key), ["total"])

        // A split fans out per group; the key carries the workout type the phone colours by.
        guard case .ok(let byType) = analytics.tiles[2] else { return XCTFail("the stacked tile should have computed") }
        XCTAssertTrue(byType.series.contains { $0.key == "s1:weights" }, byType.series.map(\.key).joined(separator: ","))

        // A grade series carries its labels; a rank is never shown.
        guard case .ok(let grade) = analytics.tiles[3] else { return XCTFail("the grade tile should have computed") }
        XCTAssertEqual(grade.series.first?.unitKind, "grade")
        XCTAssertTrue(grade.series.first?.gradeLabels?.contains("5.10c") == true)

        // An average is nil where nothing was logged — a gap, not a zero.
        guard case .ok(let hr) = analytics.tiles[4] else { return XCTFail("the line tile should have computed") }
        XCTAssertTrue(hr.series.first?.points.contains { $0 == nil } == true)
        XCTAssertTrue(hr.series.first?.points.contains { $0 == 150 } == true)

        // An unreadable distance is excluded and counted for the footnote.
        guard case .ok(let distance) = analytics.tiles[5] else { return XCTFail("the area tile should have computed") }
        XCTAssertGreaterThan(distance.excludedCount, 0)

        // A tile that could not compute carries a reason, not an exception.
        guard case .problem(let problem) = analytics.tiles[6] else { return XCTFail("the last tile should be a problem") }
        XCTAssertFalse(problem.isEmpty)
    }

    func testAnalyticsTilesDecodeAndAlignWithTheComputeFixture() throws {
        let response = try decode(AnalyticsTilesResponse.self, from: "analytics-tiles.json")
        let tiles = response.tiles
        XCTAssertEqual(tiles.map(\.id), ["sessions", "tonnage", "time", "grade", "hr", "distance"].map { "ios-fixture-tile-\($0)" })
        XCTAssertEqual(tiles.map(\.chartType), ["kpi", "bar", "stacked-bar", "table", "line", "area"])
        XCTAssertTrue(tiles.allSatisfy { $0.spec != nil && $0.draft != nil })
        XCTAssertEqual(tiles[0].layout, TileLayout(x: 0, y: 0, w: 6, h: 4))
        XCTAssertEqual(tiles[0].draft?.rangeKind, "fixed")
        XCTAssertEqual(tiles[0].draft?.endDate, "2026-09-30")   // inclusive in the draft
        XCTAssertEqual(tiles[3].draft?.series.first?.gradeScale, "yds")
        XCTAssertEqual(TileLayoutPlan.ordered(tiles).map(\.id), tiles.map(\.id))
        XCTAssertTrue(response.options.categories.contains("strength"))

        // The compute fixture is index-aligned with these tiles — the mock relies on it.
        let compute = try decode(AnalyticsComputeResponse.self, from: "analytics-compute.json")
        XCTAssertEqual(compute.tiles.count, tiles.count + 1)
        for (index, tile) in tiles.enumerated() {
            guard case .ok(let data) = compute.tiles[index] else { return XCTFail("slot \(index) should match \(tile.id)") }
            if tile.chartType == "kpi" {
                XCTAssertEqual(data.buckets.map(\.key), ["total"])
            } else {
                XCTAssertGreaterThan(data.buckets.count, 1, tile.id)
            }
        }
    }

    func testAnalyticsDraftFixturesDecode() throws {
        // The web's emptyChartDraft() is the Swift mirror's `empty`, key for key.
        let empty = try decode(ChartDraft.self, from: "chart-draft-empty.json")
        XCTAssertEqual(empty, ChartDraft.empty)

        let preview = try decode(AnalyticsComputeResponse.self, from: "analytics-compute-preview.json")
        XCTAssertEqual(preview.tiles, [.problem("Every series needs a measure.")])

        // The chart-draft reduce round-trips through the mirror without loss.
        let reduced = try decode(CoachToolResponse.self, from: "coach-tool-chart-draft.json")
        XCTAssertTrue(reduced.ok)
        let draft = try ChartDraft(jsonValue: try XCTUnwrap(reduced.draft))
        XCTAssertEqual(draft.title, "Fixture weekly tonnage")
        XCTAssertEqual(draft.chartType, "bar")
        XCTAssertEqual(draft.series.first?.measure, "tonnage")
        XCTAssertEqual(try ChartDraft(jsonValue: try draft.jsonValue()), draft)
        XCTAssertEqual(try draft.jsonValue(), reduced.draft)

        let saved = try decode(TileSaveResponse.self, from: "analytics-tiles-save.json")
        XCTAssertTrue(saved.ok)
        XCTAssertEqual(saved.tile?.id, "ios-fixture-tile-save")
        XCTAssertEqual(saved.tile?.layout, TileLayout(x: 0, y: 24, w: 12, h: 4))
        XCTAssertEqual(saved.tile?.draft?.chartType, "bar")

        // The analytics chat stream: text, the chart tool with no label, done.
        let lines = String(decoding: try load("chat-stream-analytics.ndjson"), as: UTF8.self)
            .split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 3)
        XCTAssertTrue(lines[1].contains(#""name":"update_chart_draft""#))
        XCTAssertFalse(lines[1].contains("\"label\""))
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

    // MARK: - W7

    func testScheduleCarriesTemplatesAndOriginalDates() throws {
        let schedule = try decode(ScheduleResponse.self, from: "schedule.json")
        let template = try XCTUnwrap(schedule.templates?.first)
        XCTAssertEqual(template.id, "ios-fixture-template")
        XCTAssertEqual(template.title, "Fixture Template Push")
        XCTAssertEqual(template.type, .weights)
        XCTAssertEqual(template.exercises?.first?.definitionId, "ios-fixture-def")
        XCTAssertNil(template.archivedAt)

        // Every stub says which date its exception row keys on.
        XCTAssertTrue(schedule.occurrences.allSatisfy { $0.originalDate != nil })
        let index = ScheduleIndex(schedule)
        XCTAssertEqual(index.event(id: "ios-fixture-weekly")?.keyDate, "2026-09-01")
        XCTAssertEqual(index.event(id: "ios-fixture-weekly__2026-09-08")?.keyDate, "2026-09-08")
    }

    func testBuilderChatStreamDecodesWithoutALabel() throws {
        let lines = String(decoding: try load("chat-stream-builder.ndjson"), as: UTF8.self)
            .split(separator: "\n").map(String.init)
        let events = try lines.map { try JSONDecoder().decode(ChatWireEvent.self, from: Data($0.utf8)) }
        XCTAssertEqual(events.count, 3)
        let block = try XCTUnwrap(ToolUseBlock(events[1]))
        XCTAssertEqual(block.name, "update_workout_draft")
        XCTAssertNil(block.label)
    }

    func testDraftReduceAndApplyResponsesDecode() throws {
        let reduce = try decode(CoachToolResponse.self, from: "coach-tool-draft.json")
        XCTAssertTrue(reduce.ok)
        XCTAssertNotNil(reduce.draft)
        XCTAssertEqual(try WorkoutDraft(jsonValue: try XCTUnwrap(reduce.draft)).lists.exercises.first?.definitionId, "ios-fixture-def")
        // The mutation response still decodes without a draft.
        XCTAssertNil(try decode(CoachToolResponse.self, from: "coach-tool.json").draft)

        let create = try decode(WorkoutDraftResponse.self, from: "workout-draft-create.json")
        XCTAssertTrue(create.ok)
        XCTAssertEqual(create.action, "create")
        XCTAssertEqual(create.templateId, "ios-fixture-template")
        XCTAssertEqual(create.completedOnCreate, true)
        XCTAssertEqual(create.event?.title, "Fixture Template Push")
        XCTAssertEqual(create.event?.startTime, "6:30 AM")
        XCTAssertEqual(create.event?.id, create.id)

        let edit = try decode(WorkoutDraftResponse.self, from: "workout-draft-edit.json")
        XCTAssertEqual(edit.action, "update")
        XCTAssertEqual(edit.event?.title, "Fixture Template Push (edited)")

        let detach = try decode(WorkoutDraftResponse.self, from: "workout-draft-detach.json")
        XCTAssertEqual(detach.action, "detach")
        XCTAssertEqual(detach.detachedFrom, "ios-fixture-weekly")
        XCTAssertEqual(detach.occurrenceDate, "2026-09-29")
        XCTAssertEqual(detach.event?.isRecurring, false)
        XCTAssertEqual(detach.date, "2026-09-30")
    }

    // MARK: - W10

    /// The list read: every block and objective with ids, the current block
    /// with its week, and no progress (the list needs none).
    func testTrainingBlocksListDecodes() throws {
        let list = try decode(QueryEnvelope<TrainingBlocksQueryResult>.self, from: "query-get_training_blocks.json")
        XCTAssertEqual(list.tool, "get_training_blocks")
        XCTAssertEqual(list.result.today, "2026-09-08")
        let blocks = try XCTUnwrap(list.result.blocks)
        XCTAssertEqual(blocks.map(\.id), ["ios-fixture-block-spring", "ios-fixture-block-base"])
        XCTAssertEqual(blocks.map(\.currentWeek), [nil, 2])
        XCTAssertEqual(blocks.map(\.weeks), [4, 4])
        XCTAssertTrue(blocks[0].weeklyTargets.isEmpty)
        XCTAssertEqual(blocks[1].weeklyTargets.cardioMinutes, 60)
        XCTAssertEqual(blocks[1].objectiveId, "ios-fixture-objective-1")
        XCTAssertEqual(blocks[1].objective?.id, blocks[1].objectiveId)
        XCTAssertNil(blocks[1].progress)

        let current = try XCTUnwrap(list.result.current)
        XCTAssertEqual(current.id, "ios-fixture-block-base")
        XCTAssertNil(current.progress)
        XCTAssertNil(list.result.block)

        let objectives = try XCTUnwrap(list.result.objectives)
        XCTAssertEqual(objectives.map(\.id), ["ios-fixture-objective-1"])
        XCTAssertEqual(objectives[0].discipline, "alpine")
        XCTAssertEqual(objectives[0].targetDate, "2027-05-01")
    }

    /// The detail read: one block's progress by id — to date, per week,
    /// the authored and derived targets, and the PR set inside the block.
    func testTrainingBlockDetailDecodes() throws {
        let detail = try decode(QueryEnvelope<TrainingBlocksQueryResult>.self, from: "query-get_training_blocks-detail.json")
        let block = try XCTUnwrap(detail.result.block)
        XCTAssertEqual(block.id, "ios-fixture-block-base")
        XCTAssertEqual(block.currentWeek, 2)
        let progress = try XCTUnwrap(block.progress)
        XCTAssertEqual(progress.weeksTotal, 4)
        XCTAssertEqual(progress.weeksElapsed, 1)
        XCTAssertEqual(progress.currentWeek, 2)
        XCTAssertEqual(progress.weeks.map(\.isComplete), [true, false, false, false])
        XCTAssertEqual(progress.weeks[1].sessionsCompleted, 1)
        XCTAssertEqual(progress.weeks[1].startDate, "2026-09-07")

        let toDate = progress.toDate.attainment
        XCTAssertEqual(toDate.filter { !$0.isDerived }.map(\.key), ["cardioMinutes", "strengthSessions"])
        XCTAssertTrue(toDate.contains { $0.isDerived })
        XCTAssertEqual(toDate[0].label, "Cardio")
        XCTAssertEqual(toDate[0].unit, "min")
        XCTAssertEqual(toDate[0].pct, 0)

        let pr = try XCTUnwrap(progress.prs.first)
        XCTAssertEqual(pr.kind, "oneRM")
        XCTAssertEqual(pr.exerciseName, "Fixture Press")
        XCTAssertEqual(pr.date, "2026-09-22")
        XCTAssertTrue(pr.description.hasPrefix("est. 1RM 132"))
        // The current block is named, but its progress was not computed twice.
        XCTAssertNil(detail.result.current?.progress)
    }

    /// Alias-aware history: asked by the former spelling, answered under the
    /// canonical name with the stats the detail screen renders.
    func testExerciseHistoryDecodes() throws {
        let history = try decode(QueryEnvelope<ExerciseHistoryResult>.self, from: "query-get_exercise_history.json")
        XCTAssertEqual(history.tool, "get_exercise_history")
        XCTAssertEqual(history.result.canonicalName, "Fixture Press")
        XCTAssertEqual(history.result.resolvedFrom, "fx press")
        XCTAssertEqual(history.result.statKind, "oneRM")
        XCTAssertEqual(history.result.statUnit, "est. 1RM")
        XCTAssertEqual(history.result.allTimeBest?.display, "132")
        XCTAssertEqual(history.result.totalSessions, 2)
        XCTAssertEqual(history.result.trend.map(\.date), ["2026-09-08", "2026-09-22"])
        XCTAssertEqual(history.result.recentSessions.first?.sets, ["120 × 3"])
    }

    /// The library decoration carries ids and reference counts since W10.
    func testSearchExercisesCarriesIdsAndReferences() throws {
        let search = try decode(QueryEnvelope<SearchExercisesResult>.self, from: "query-search_exercises.json")
        let entry = try XCTUnwrap(search.result.exercises.first)
        XCTAssertEqual(entry.id, "ios-fixture-def")
        XCTAssertEqual(entry.references, 1)
        XCTAssertEqual(entry.muscleGroups, ["chest"])
        XCTAssertEqual(entry.equipment, ["barbell"])
        XCTAssertEqual(entry.lastPerformed, "2026-09-22")
        XCTAssertNotNil(entry.defaultPrescription)
    }

    /// Meal items carry their id and the whole fat split since W10.
    func testMealItemsCarryIdsAndTheFatSplit() throws {
        let meals = try decode(QueryEnvelope<MealsQueryResult>.self, from: "query-get_meals.json")
        let items = try XCTUnwrap(meals.result.days.first?.meals)
        XCTAssertEqual(items.map(\.id), ["ios-fixture-meal-1", "ios-fixture-meal-2"])
        XCTAssertEqual(items[1].fatSaturatedG, 4)
        XCTAssertEqual(items[1].fatTransG, 0)
        XCTAssertNil(items[1].alcoholG)
        // The split never changes the derived calories.
        XCTAssertEqual(items[1].calories, 594)
    }

    func testMealFavoritesDecode() throws {
        let favorites = try decode(MealFavoritesResponse.self, from: "meal-favorites.json")
        let oats = try XCTUnwrap(favorites.favorites.first)
        XCTAssertEqual(oats.id, "ios-fixture-fav-1")
        XCTAssertEqual(oats.title, "Fixture Overnight Oats")
        XCTAssertEqual(oats.mealType, "breakfast")
        XCTAssertEqual(oats.calories, 420)
        XCTAssertEqual(oats.fatSaturatedG, 2)
        XCTAssertNil(oats.fatTransG)
        XCTAssertEqual(oats.notes, "Prep the night before.")
    }

    /// The three answers a cycle preview can give: the blocks with the rows
    /// that commit them, a named conflict, and the generator's refusal.
    func testCyclePreviewFixturesDecode() throws {
        let ok = try decode(CyclePreviewResponse.self, from: "blocks-cycle.json")
        XCTAssertTrue(ok.ok)
        XCTAssertNil(ok.problem)
        XCTAssertNil(ok.conflict)
        XCTAssertEqual(ok.totalWeeks, 8)
        let blocks = try XCTUnwrap(ok.blocks)
        XCTAssertEqual(blocks.map(\.phase), ["build", "recovery", "build", "recovery"])
        XCTAssertEqual(blocks[0].name, "Fixture Cycle · Build 1")
        XCTAssertEqual(blocks[0].startDate, "2027-01-04")
        XCTAssertEqual(blocks[0].objectiveId, "ios-fixture-objective-1")
        XCTAssertEqual(blocks[1].weeklyTargets.cardioMinutes, 150)
        XCTAssertEqual(blocks[1].weeklyTargets.vert, .init(value: 1500, unit: "ft"))
        // One row per block, ready to send back as the batch body.
        let rows = try XCTUnwrap(ok.rows)
        XCTAssertEqual(rows.count, blocks.count)
        XCTAssertEqual(rows[0], .object([
            "objective_id": .string("ios-fixture-objective-1"),
            "name": .string("Fixture Cycle · Build 1"),
            "intent": .string("Winter build"),
            "phase": .string("build"),
            "start_date": .string("2027-01-04"),
            "end_date_exclusive": .string("2027-01-25"),
            "weekly_targets": .object([
                "cardioMinutes": .number(300), "strengthSessions": .number(2),
                "vert": .object(["value": .number(3000), "unit": .string("ft")]),
            ]),
        ]))

        let conflict = try decode(CyclePreviewResponse.self, from: "blocks-cycle-conflict.json")
        XCTAssertTrue(conflict.ok)
        XCTAssertEqual(conflict.conflict?.name, "Fixture Base Block")
        XCTAssertEqual(conflict.conflict?.startDate, "2026-08-31")
        XCTAssertEqual(conflict.blocks?.count, 4)

        let problem = try decode(CyclePreviewResponse.self, from: "blocks-cycle-problem.json")
        XCTAssertFalse(problem.ok)
        XCTAssertEqual(problem.problem, "A cycle needs a name")
        XCTAssertNil(problem.blocks)
    }
}
