import XCTest
@testable import ApexCore

/// Opt-in: `APEX_PERF=1 swift test --filter VoicePerfTests`. The parser runs
/// on every partial while the user is still talking, so it must be cheap.
final class VoicePerfTests: XCTestCase {
    func testAThousandParsesOfFiveAlternativesTakeUnderASecond() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["APEX_PERF"] == "1", "set APEX_PERF=1 to run")
        let upper = try VoiceFixture.load().context(named: "upper")
        let alternatives = ["bench 5 at 225", "bench five at two twenty five", "bench 5 at 2 25", "back squad 5 at 225", "5 at 225 rpe 8"]
        let start = Date()
        var chosen = 0
        for _ in 0..<1000 {
            chosen += VoiceParser.parse(alternatives: alternatives, context: upper).chosen
        }
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(chosen, 0, "the engine's first alternative is the best here")
        XCTAssertLessThan(elapsed, 1.0, "1,000 × 5 parses took \(elapsed) s")
    }
}
