import XCTest
@testable import ApexCore

final class ActivityStreamsTests: XCTestCase {
    func testDecodesTuplesAndIgnoresExtraSummaryKeys() throws {
        let json = """
        {"provider":"coros",
         "summary":{"sport":"run","sportLabel":"Run","startUtc":"2026-09-08T11:00:00Z","durationSec":1800,
                    "avgHr":150,"maxHr":172,"calories":420,"distanceMeters":8046.72,"elevationGainMeters":243.84,"trainingLoad":88,
                    "hrZones":[1,2,3]},
         "streams":{"hr":[[0,120],[60,140],[120,155]],"gps":[[0,41.3,-72.9,10],[60,41.31,-72.91]]}}
        """
        let record = try JSONDecoder().decode(ActivityStreamRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.hrSamples.count, 3)
        XCTAssertEqual(record.hrSamples[2].bpm, 155)
        XCTAssertEqual(record.gpsSamples.count, 2)
        XCTAssertEqual(record.gpsSamples[0].elevationMeters, 10)
        XCTAssertNil(record.gpsSamples[1].elevationMeters)

        let items = SyncMetricsFormatter.items(record.summary)
        XCTAssertEqual(items.map(\.text), ["150/172 bpm", "5.00 mi", "800 ft", "420 cal", "Load 88"])
        XCTAssertEqual(SyncMetricsFormatter.providerLabel("coros"), "COROS")
        XCTAssertEqual(SyncMetricsFormatter.providerLabel("garmin"), "garmin")
    }

    func testZeroAndNilAreNotMeasured() {
        let items = SyncMetricsFormatter.items(.init(avgHr: 140, maxHr: 0, calories: 0))
        XCTAssertEqual(items.map(\.text), ["140 bpm"])
        XCTAssertTrue(SyncMetricsFormatter.items(.init()).isEmpty)
    }

    func testNullStreamsDecode() throws {
        let record = try JSONDecoder().decode(ActivityStreamRecord.self, from: Data(#"{"provider":"coros","summary":{},"streams":null}"#.utf8))
        XCTAssertNil(record.streams)
        XCTAssertTrue(record.hrSamples.isEmpty)
    }

    func testDownsampleKeepsEndpoints() {
        let samples = Array(0..<2000)
        let out = StreamDownsample.stride(samples, maxCount: 600)
        XCTAssertEqual(out.count, 600)
        XCTAssertEqual(out.first, 0)
        XCTAssertEqual(out.last, 1999)
        XCTAssertEqual(StreamDownsample.stride([1, 2, 3], maxCount: 600), [1, 2, 3])
    }
}
