import Foundation
import XCTest
@testable import ApexCore

/// D-061: the port runs the vector file the web's
/// `src/lib/tracking/__tests__/runawayFinish.test.ts` runs, so the two rules
/// cannot drift. The vectors are UTC instants; `suggestedAt` is compared as one.
final class RunawayFinishTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Rule: Decodable { let planMultiple: Double; let floorSeconds: Double }
        struct Case: Decodable {
            struct Expect: Decodable {
                let runaway: Bool
                let suggestedAt: String
                let basis: String
                let elapsedLabel: String
                let plannedLabel: String?
            }
            let name: String
            let startedAt: String
            let now: String
            let plannedMinutes: Double?
            let lastLoggedAt: String?
            let expect: Expect
        }
        let rule: Rule
        let cases: [Case]
    }

    private static func vectors() throws -> Vectors {
        try JSONDecoder().decode(Vectors.self, from: TestFixtures.local("runaway-finish.json"))
    }

    private static func date(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = formatter.date(from: iso) { return d }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)!
    }

    func testTheVectorsStateTheRuleThePortHolds() throws {
        let vectors = try Self.vectors()
        XCTAssertEqual(vectors.rule.planMultiple, RunawayFinish.planMultiple)
        XCTAssertEqual(vectors.rule.floorSeconds, RunawayFinish.floorSeconds)
        XCTAssertGreaterThanOrEqual(vectors.cases.count, 19)
    }

    func testEverySharedVector() throws {
        for c in try Self.vectors().cases {
            let started = Self.date(c.startedAt)
            let now = Self.date(c.now)
            let last = c.lastLoggedAt.map(Self.date)
            let elapsed = now.timeIntervalSince(started)
            let expected = RunawayFinish.Suggestion(at: Self.date(c.expect.suggestedAt), basis: RunawayFinish.Basis(rawValue: c.expect.basis)!)

            XCTAssertEqual(RunawayFinish.isRunaway(elapsedSeconds: elapsed, plannedMinutes: c.plannedMinutes), c.expect.runaway, c.name)
            let detected = RunawayFinish.detect(startedAt: started, now: now, plannedMinutes: c.plannedMinutes, lastLoggedAt: last)
            XCTAssertEqual(detected != nil, c.expect.runaway, c.name)
            if let detected {
                XCTAssertEqual(detected.suggestion, expected, c.name)
                XCTAssertEqual(detected.plannedMinutes, c.plannedMinutes, c.name)
            }
            XCTAssertEqual(
                RunawayFinish.suggestFinish(startedAt: started, now: now, plannedMinutes: c.plannedMinutes, lastLoggedAt: last),
                expected, c.name
            )
            XCTAssertEqual(RunawayFinish.formatLength(seconds: elapsed), c.expect.elapsedLabel, c.name)
            if let label = c.expect.plannedLabel, let minutes = c.plannedMinutes {
                XCTAssertEqual(RunawayFinish.formatLength(seconds: minutes * 60), label, c.name)
            }
        }
    }

    /// What JSON cannot carry: the web's "a non-finite plan or elapsed time is never a runaway".
    func testANonFinitePlanOrElapsedTimeIsNeverARunaway() {
        XCTAssertFalse(RunawayFinish.isRunaway(elapsedSeconds: 36_000, plannedMinutes: .nan))
        XCTAssertFalse(RunawayFinish.isRunaway(elapsedSeconds: 36_000, plannedMinutes: .infinity))
        XCTAssertFalse(RunawayFinish.isRunaway(elapsedSeconds: 36_000, plannedMinutes: nil))
        XCTAssertFalse(RunawayFinish.isRunaway(elapsedSeconds: .nan, plannedMinutes: 30))
        XCTAssertFalse(RunawayFinish.isRunaway(elapsedSeconds: .infinity, plannedMinutes: 30))
    }

    /// The emitter's bootstraps (M1): a session with logged rows carries the
    /// stamp; a peek before the start has none. Absent decodes as nil too.
    func testTheBootstrapCarriesLastLoggedAt() throws {
        let logged = try JSONDecoder().decode(TrackerBootstrap.self, from: TestFixtures.data("bootstrap.json"))
        XCTAssertNotNil(logged.lastLoggedAt)
        let peek = try JSONDecoder().decode(TrackerBootstrap.self, from: TestFixtures.data("bootstrap-peek.json"))
        XCTAssertNil(peek.lastLoggedAt)
        let old = try JSONDecoder().decode(TrackerBootstrap.self, from: Data(#"{"session":null,"event":null,"groups":[],"scored":false}"#.utf8))
        XCTAssertNil(old.lastLoggedAt)
    }

    func testTheLengthReadsLikeATimer() {
        XCTAssertEqual(RunawayFinish.formatLength(seconds: 0), "0 min")
        XCTAssertEqual(RunawayFinish.formatLength(seconds: 59), "0 min")
        XCTAssertEqual(RunawayFinish.formatLength(seconds: -5), "0 min")
        XCTAssertEqual(RunawayFinish.formatLength(seconds: .nan), "0 min")
        XCTAssertEqual(RunawayFinish.formatLength(seconds: 3600), "1 h")
        XCTAssertEqual(RunawayFinish.formatLength(seconds: 86_400), "1 d")
        XCTAssertEqual(RunawayFinish.formatLength(seconds: 86_400 + 59 * 60), "1 d")
    }
}
