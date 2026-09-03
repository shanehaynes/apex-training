import XCTest
@testable import ApexCore

final class WorkoutTypeTests: XCTestCase {
    func testRoundTripsEveryKnownType() {
        for type in WorkoutType.known {
            XCTAssertEqual(WorkoutType(rawValue: type.rawValue), type)
        }
        XCTAssertEqual(WorkoutType.known.count, 7)
    }

    /// A type the server adds before the app ships must not fail the decode —
    /// one unknown event would otherwise take the whole schedule down.
    func testUnknownTypeSurvivesDecoding() throws {
        struct Holder: Codable { let type: WorkoutType }
        let holder = try JSONDecoder().decode(Holder.self, from: Data(#"{"type":"surfing"}"#.utf8))
        XCTAssertEqual(holder.type, .unknown("surfing"))
        XCTAssertEqual(holder.type.rawValue, "surfing")
    }
}
