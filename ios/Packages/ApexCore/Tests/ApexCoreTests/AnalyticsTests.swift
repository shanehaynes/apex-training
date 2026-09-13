import XCTest
@testable import ApexCore

/// The dashboard's pure pieces (W9): the draft mirror's constructors, the
/// generated catalog, the colour and layout mappings, the number formatter.

final class ChartDraftTests: XCTestCase {
    func testEmptyMatchesTheWebsEmptyChartDraft() throws {
        let draft = ChartDraft.empty
        XCTAssertEqual(draft.chartType, "line")
        XCTAssertEqual(draft.rangeKind, "rolling")
        XCTAssertEqual(draft.rollingDays, "90")
        XCTAssertEqual(draft.preset, "this-iso-month")
        XCTAssertEqual(draft.bucket, "week")
        XCTAssertEqual(draft.series.map(\.id), ["s1"])
        XCTAssertEqual(draft.series[0].dayFilterOffset, "0")
        XCTAssertEqual(draft.series[0].dayFilterMode, "include")
        // Every key the web writes, and nothing else, sorted as Endpoint.json sorts.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let text = String(decoding: try encoder.encode(draft), as: UTF8.self)
        XCTAssertEqual(text, #"{"bucket":"week","chartType":"line","displayUnit":"","endDate":"","preset":"this-iso-month","rangeKind":"rolling","rollingDays":"90","series":[{"agg":"","axis":"","categories":[],"dayFilterMode":"include","dayFilterOffset":"0","dayFilterTypes":[],"eventTypes":[],"exerciseNames":[],"gradeScale":"","groupBy":"","groupLimit":"","id":"s1","label":"","mealTypes":[],"measure":"","sports":[],"workoutTitles":[]}],"startDate":"","title":""}"#)
    }

    func testNextSeriesIdSkipsUsedIds() {
        var draft = ChartDraft.empty
        XCTAssertEqual(draft.nextSeriesId(), "s2")
        draft.series.append(.empty(id: "s2"))
        draft.series.append(.empty(id: "s4"))
        XCTAssertEqual(draft.nextSeriesId(), "s3")
        draft.series.removeAll()
        XCTAssertEqual(draft.nextSeriesId(), "s1")
    }

    func testJSONValueRoundTripIsLossless() throws {
        var draft = ChartDraft.empty
        draft.title = "Weekly mileage"
        draft.series[0].measure = "distance"
        draft.series[0].sports = ["running"]
        draft.series[0].groupLimit = "3"
        let json = try draft.jsonValue()
        guard case .object(let object) = json else { return XCTFail("draft should encode as an object") }
        XCTAssertEqual(object["title"], "Weekly mileage")
        XCTAssertEqual(try ChartDraft(jsonValue: json), draft)
    }
}

final class AnalyticsCatalogTests: XCTestCase {
    func testEveryMeasureSitsInExactlyOneGroup() {
        let grouped = AnalyticsCatalog.measureGroups.flatMap(\.ids)
        XCTAssertEqual(grouped.sorted(), AnalyticsCatalog.measures.map(\.id).sorted())
        XCTAssertEqual(Set(grouped).count, grouped.count)
        for id in grouped { XCTAssertNotNil(AnalyticsCatalog.measure(id), id) }
    }

    func testTheSportBlocklistAndLimitsMatchSpecTs() {
        XCTAssertEqual(AnalyticsCatalog.measure("distance")?.blockedSports, ["climbing"])
        XCTAssertEqual(AnalyticsCatalog.measure("elevation-gain")?.blockedSports, ["swimming", "climbing"])
        XCTAssertEqual(AnalyticsCatalog.measure("pitches")?.blockedSports, ["running", "biking", "swimming", "other"])
        XCTAssertEqual(AnalyticsCatalog.measure("tonnage")?.blockedSports, [])
        XCTAssertEqual(AnalyticsCatalog.measure("max-grade")?.allowedAggs, ["max"])
        XCTAssertEqual(AnalyticsCatalog.measure("max-grade")?.allowedGroupBys, [])
        XCTAssertEqual(AnalyticsCatalog.measure("calories")?.aggLevel, "day")
        XCTAssertEqual(AnalyticsCatalog.maxSeries, 8)
        XCTAssertEqual(AnalyticsCatalog.maxRollingDays, 1830)
        XCTAssertEqual(AnalyticsCatalog.defaultGroupLimit, 6)
        XCTAssertEqual(AnalyticsCatalog.maxGroupLimit, 12)
    }

    func testTheLabelsAreTheWebs() {
        XCTAssertEqual(AnalyticsCatalog.chartTypes.map(\.label), ["Line", "Bar", "Stacked", "Area", "Stat", "Table"])
        XCTAssertEqual(AnalyticsCatalog.buckets.map(\.value), ["day", "week", "iso-month", "total"])
        XCTAssertEqual(AnalyticsCatalog.gradeScales.map(\.label), ["YDS", "V-grade", "WI/AI", "M"])
        XCTAssertEqual(AnalyticsCatalog.groupByLabels["event-type"], "Workout type")
        XCTAssertEqual(AnalyticsCatalog.workoutTypes.first, .init(value: "stretching", label: "Stretching"))
        XCTAssertEqual(AnalyticsCatalog.dayFilterModes.map(\.label), ["Only those days", "Everything else"])
        XCTAssertTrue(AnalyticsCatalog.otherSportHint.hasPrefix("No workouts marked"))
    }
}

/// Vectors copied verbatim from `src/lib/analytics/__tests__/palette.test.ts`.
final class SeriesColorsTests: XCTestCase {
    func testWalksTheRampByPositionForPlainSeries() {
        XCTAssertEqual(SeriesColors.assign(keys: ["s1"]), [.ramp(0)])
        XCTAssertEqual(SeriesColors.assign(keys: ["s1", "s2", "s3"]), [.ramp(0), .ramp(1), .ramp(2)])
    }

    func testGivesAWorkoutTypeGroupItsAppColour() {
        XCTAssertEqual(SeriesColors.assign(keys: ["s1:weights", "s1:cardio"]), [.workoutType("weights"), .workoutType("cardio")])
    }

    func testDoesNotLetAWorkoutTypeGroupConsumeARampSlot() {
        XCTAssertEqual(SeriesColors.assign(keys: ["s1", "s2:weights", "s3"]), [.ramp(0), .workoutType("weights"), .ramp(1)])
    }

    func testWrapsTheRampAfterEightPlainSeries() {
        let nine = SeriesColors.assign(keys: (1...9).map { "s\($0)" })
        XCTAssertEqual(nine[8], .ramp(0))
        XCTAssertEqual(Array(nine[0..<8]), (0..<8).map { .ramp($0) })
    }

    func testTreatsAGroupThatIsNotAWorkoutTypeAsAPlainSeries() {
        XCTAssertEqual(SeriesColors.assign(keys: ["s1:running", "s1:biking"]), [.ramp(0), .ramp(1)])
    }
}

final class TileFormatTests: XCTestCase {
    func testFormatsLikeTheWebRenderer() {
        XCTAssertEqual(TileFormat.value(nil), "—")
        XCTAssertEqual(TileFormat.value(1234.5), "1,235")
        XCTAssertEqual(TileFormat.value(1000), "1,000")
        XCTAssertEqual(TileFormat.value(-1500), "-1,500")
        XCTAssertEqual(TileFormat.value(999.96), "1000")
        XCTAssertEqual(TileFormat.value(12.34), "12.3")
        XCTAssertEqual(TileFormat.value(12), "12")
        XCTAssertEqual(TileFormat.value(0.05), "0.1")
        XCTAssertEqual(TileFormat.value(0), "0")
    }

    func testAGradeLabelBeatsTheNumberAndUnitsFollowValues() {
        let grade = TileData.Series(key: "s1", label: "Max grade", unitKind: "grade", unit: "", points: [1050, nil], gradeLabels: ["5.10c", nil])
        XCTAssertEqual(TileFormat.value(grade, at: 0), "5.10c")
        XCTAssertEqual(TileFormat.value(grade, at: 1), "—")
        let miles = TileData.Series(key: "s1", label: "Distance", unitKind: "length", unit: "mi", points: [5.25, nil])
        XCTAssertEqual(TileFormat.value(miles, at: 0), "5.3 mi")
        XCTAssertEqual(TileFormat.value(miles, at: 1), "—")
        XCTAssertEqual(TileFormat.value(miles, at: 7), "—")
    }

    func testFootnoteAndCounts() {
        XCTAssertNil(TileFormat.excluded(count: 0))
        XCTAssertEqual(TileFormat.excluded(count: 1), "1 entry excluded")
        XCTAssertEqual(TileFormat.excluded(count: 3), "3 entries excluded")
        XCTAssertEqual(TileFormat.tileCount(1), "1 tile")
        XCTAssertEqual(TileFormat.tileCount(6), "6 tiles")
    }
}

final class TileLayoutPlanTests: XCTestCase {
    private func tile(_ id: String, y: Int, h: Int, x: Int = 0, w: Int = 6) -> AnalyticsTile {
        AnalyticsTile(id: id, title: id, spec: nil, draft: nil, layout: TileLayout(x: x, y: y, w: w, h: h))
    }

    func testOrderBecomesCumulativeYFullWidth() {
        let tiles = [tile("a", y: 0, h: 4), tile("b", y: 4, h: 3), tile("c", y: 8, h: 8)]
        let plan = TileLayoutPlan.layouts(order: [tiles[2], tiles[0], tiles[1]], heights: ["a": .small])
        XCTAssertEqual(plan, [
            TileLayoutUpdate(id: "c", x: 0, y: 0, w: 12, h: 6),   // h 8 → nearest L
            TileLayoutUpdate(id: "a", x: 0, y: 6, w: 12, h: 2),   // chip S
            TileLayoutUpdate(id: "b", x: 0, y: 8, w: 12, h: 4),   // h 3 → nearest M (ties round up)
        ])
    }

    func testNearestHeightStep() {
        XCTAssertEqual(TileHeight.nearest(h: 1), .small)
        XCTAssertEqual(TileHeight.nearest(h: 3), .medium)
        XCTAssertEqual(TileHeight.nearest(h: 5), .large)
        XCTAssertEqual(TileHeight.nearest(h: 24), .large)
        XCTAssertEqual(TileHeight.nearest(h: 4), .medium)
    }

    func testOnlyChangedRowsArePatched() {
        let tiles = [tile("a", y: 0, h: 4, w: 12), tile("b", y: 4, h: 4, w: 12)]
        let plan = TileLayoutPlan.layouts(order: tiles, heights: [:])
        XCTAssertEqual(TileLayoutPlan.changed(plan, from: tiles), [])
        let swapped = TileLayoutPlan.layouts(order: [tiles[1], tiles[0]], heights: [:])
        XCTAssertEqual(TileLayoutPlan.changed(swapped, from: tiles).map(\.id), ["b", "a"])
        let resized = TileLayoutPlan.layouts(order: tiles, heights: ["b": .large])
        XCTAssertEqual(TileLayoutPlan.changed(resized, from: tiles), [TileLayoutUpdate(id: "b", x: 0, y: 4, w: 12, h: 6)])
    }

    func testNewTilesLandBelowTheDashboardAndOrderingFollowsYThenX() {
        let tiles = [tile("a", y: 0, h: 4), tile("b", y: 0, h: 6, x: 6), tile("c", y: 6, h: 2)]
        XCTAssertEqual(TileLayoutPlan.maxBottom(tiles), 8)
        XCTAssertEqual(TileLayoutPlan.nextLayout(after: tiles, height: .medium), TileLayout(x: 0, y: 8, w: 12, h: 4))
        XCTAssertEqual(TileLayoutPlan.nextLayout(after: [], height: .small), TileLayout(x: 0, y: 0, w: 12, h: 2))
        XCTAssertEqual(TileLayoutPlan.ordered([tiles[2], tiles[1], tiles[0]]).map(\.id), ["a", "b", "c"])
    }
}
