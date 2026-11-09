import Foundation
import XCTest
@testable import ApexCore

/// `CompletionRows.isoTimestamp` must give back the instant a server stamp
/// names, to the millisecond: a finish clamped to a session's start is sent
/// as that start, and one millisecond early the server refuses it (D-061).
final class IsoTimestampTests: XCTestCase {
    /// The tracker's own parser (`TrackerModel.parseISO`): fractional first.
    private static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    func testEveryMillisecondOfAServerStampRoundTrips() throws {
        var drifted: [String] = []
        for ms in 0..<1000 {
            let digits = String(format: "%03d", ms)
            let date = try XCTUnwrap(Self.parse("2026-11-08T21:30:42.\(digits)+00:00"))
            let out = CompletionRows.isoTimestamp(date)
            if out != "2026-11-08T21:30:42.\(digits)Z" { drifted.append("\(digits) → \(out)") }
        }
        XCTAssertEqual(drifted, [], "\(drifted.count) of 1000 drifted")
    }

    func testSubMillisecondsRoundToTheNearest() {
        let base = Date(timeIntervalSince1970: 1_790_078_400)  // 2026-09-22T12:00:00Z
        XCTAssertEqual(CompletionRows.isoTimestamp(base), "2026-09-22T12:00:00.000Z")
        XCTAssertEqual(CompletionRows.isoTimestamp(base.addingTimeInterval(0.0004)), "2026-09-22T12:00:00.000Z")
        XCTAssertEqual(CompletionRows.isoTimestamp(base.addingTimeInterval(0.0006)), "2026-09-22T12:00:00.001Z")
        // Rounding up across a day boundary carries into the date.
        XCTAssertEqual(CompletionRows.isoTimestamp(base.addingTimeInterval(12 * 3600 - 0.0004)), "2026-09-23T00:00:00.000Z")
    }
}
