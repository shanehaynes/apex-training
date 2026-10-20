import XCTest
@testable import ApexCore

/// Every case in `Fixtures/voice-cases.json` against the parser. The fixture
/// is the grammar's contract and only grows (D-059): a failed utterance from
/// the journal becomes a `journal:<date>` case, red, and the rules change
/// until it is green — never the other way round.
final class VoiceFixtureTests: XCTestCase {
    /// The only-grows ratchet: raise it with every case added, never lower it.
    static let committedCaseCount = 63

    private static let allRules = (1...17).map { "R\($0)" }
    private static let allTiers = [
        "current", "1 exact-session", "2 contained-session", "3 near-session",
        "4 exact-library", "5 contained-or-near-library", "6 unresolved",
    ]

    func testEveryCaseParsesAsExpected() throws {
        let fixture = try VoiceFixture.load()
        XCTAssertEqual(fixture.version, 1)
        for c in fixture.cases {
            let context = try fixture.context(named: c.context)
            let parse = VoiceParser.parse(alternatives: c.input, context: context)
            XCTAssertEqual(parse.status.rawValue, c.expect.status, "\(c.label): status")
            XCTAssertEqual(parse.chosen, c.expect.chosen, "\(c.label): chosen alternative")
            XCTAssertEqual(parse.transcript, c.input[c.expect.chosen], "\(c.label): transcript")
            XCTAssertEqual(parse.intent, try c.expect.intent.map { try XCTUnwrap($0.spoken, "\(c.label): malformed expected intent") },
                           "\(c.label): intent")
            XCTAssertEqual(parse.exercise, try XCTUnwrap(c.expect.exercise.spoken, "\(c.label): malformed expected exercise"),
                           "\(c.label): exercise")
            XCTAssertEqual(parse.ignored, c.expect.ignored, "\(c.label): ignored words")
            XCTAssertEqual(parse.problems.map(\.rawValue), c.expect.problems, "\(c.label): problems")
            XCTAssertEqual(parse.rules, Set(c.rules), "\(c.label): rules that fired")
            // The single-transcript entry point agrees with the chosen alternative.
            let single = VoiceParser.parse(c.input[c.expect.chosen], context: context)
            XCTAssertEqual(single.intent, parse.intent, "\(c.label): parse(_:context:) intent")
            XCTAssertEqual(single.exercise, parse.exercise, "\(c.label): parse(_:context:) exercise")
            XCTAssertEqual(single.score, parse.score, "\(c.label): parse(_:context:) score")
        }
    }

    func testTheFixtureOnlyGrows() throws {
        let fixture = try VoiceFixture.load()
        XCTAssertGreaterThanOrEqual(fixture.cases.count, Self.committedCaseCount)
        let ids = fixture.cases.map(\.id)
        XCTAssertEqual(ids, ids.sorted(), "cases stay in id order")
        XCTAssertEqual(Set(ids).count, ids.count, "ids are unique")
    }

    func testEveryCaseNamesItsSource() throws {
        for c in try VoiceFixture.load().cases {
            let journal = c.source.hasPrefix("journal:") && c.source.count == "journal:yyyy-mm-dd".count
            XCTAssertTrue(c.source == "authored" || journal, "\(c.label): source '\(c.source)'")
            XCTAssertFalse(c.input.isEmpty, "\(c.label): at least one alternative")
            XCTAssertTrue(c.input.indices.contains(c.expect.chosen), "\(c.label): chosen in range")
        }
    }

    func testEveryRuleTierAndProblemIsCovered() throws {
        let fixture = try VoiceFixture.load()
        let rules = Set(fixture.cases.flatMap(\.rules))
        for rule in Self.allRules {
            XCTAssertTrue(rules.contains(rule), "no case exercises \(rule)")
        }
        XCTAssertTrue(rules.isSubset(of: Self.allRules), "unknown rules \(rules.subtracting(Self.allRules))")
        let tiers = Set(fixture.cases.map(\.expect.exercise.tier))
        for tier in Self.allTiers {
            XCTAssertTrue(tiers.contains(tier), "no case reaches tier \(tier)")
        }
        XCTAssertTrue(tiers.isSubset(of: Self.allTiers), "unknown tiers \(tiers.subtracting(Self.allTiers))")
        let problems = Set(fixture.cases.flatMap(\.expect.problems))
        for problem in SpokenProblem.allCases {
            XCTAssertTrue(problems.contains(problem.rawValue), "no case raises \(problem)")
        }
        XCTAssertTrue(problems.isSubset(of: SpokenProblem.allCases.map(\.rawValue)), "unknown problems")
    }
}
