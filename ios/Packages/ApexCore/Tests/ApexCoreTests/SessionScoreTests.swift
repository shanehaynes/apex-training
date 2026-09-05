import XCTest
@testable import ApexCore

final class SessionScoreTests: XCTestCase {
    private func json<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    func testCodableGoldenBothWays() throws {
        let forTime = SessionScore.forTime(timeSeconds: 2492)
        XCTAssertEqual(try json(forTime), #"{"timeSeconds":2492,"type":"for-time"}"#)
        let amrap = SessionScore.amrap(rounds: 18, reps: 7)
        XCTAssertEqual(try json(amrap), #"{"reps":7,"rounds":18,"type":"amrap"}"#)
        for score in [forTime, amrap] {
            let data = try JSONEncoder().encode(score)
            XCTAssertEqual(try JSONDecoder().decode(SessionScore.self, from: data), score)
        }
        // The finish body's flat shape, with the template the PR lineage keys on.
        let submission = ScoreSubmission(templateId: "wt-murph", score: forTime)
        XCTAssertEqual(try json(submission), #"{"templateId":"wt-murph","timeSeconds":2492,"type":"for-time"}"#)
        XCTAssertEqual(try JSONDecoder().decode(ScoreSubmission.self, from: try JSONEncoder().encode(submission)), submission)
    }

    func testFromASessionRow() {
        XCTAssertEqual(SessionScore(scoreType: "for-time", timeSeconds: 2492, rounds: nil, reps: nil), .forTime(timeSeconds: 2492))
        XCTAssertNil(SessionScore(scoreType: "for-time", timeSeconds: 0, rounds: nil, reps: nil))
        XCTAssertNil(SessionScore(scoreType: "for-time", timeSeconds: nil, rounds: nil, reps: nil))
        XCTAssertEqual(SessionScore(scoreType: "amrap", timeSeconds: nil, rounds: 5, reps: nil), .amrap(rounds: 5, reps: 0))
        XCTAssertNil(SessionScore(scoreType: "amrap", timeSeconds: nil, rounds: nil, reps: 3))
        XCTAssertNil(SessionScore(scoreType: nil, timeSeconds: 10, rounds: 1, reps: 1))

        let session = TrackerBootstrap.Session(
            id: "s", userId: "u", eventId: "e", eventDate: "2026-09-08",
            scoreType: "amrap", scoreRounds: 12, scoreReps: 4
        )
        XCTAssertEqual(SessionScore(session: session), .amrap(rounds: 12, reps: 4))
    }

    func testFormatted() {
        XCTAssertEqual(SessionScore.forTime(timeSeconds: 754).formatted, "12:34")
        XCTAssertEqual(SessionScore.forTime(timeSeconds: 3723).formatted, "1:02:03")
        XCTAssertEqual(SessionScore.amrap(rounds: 5, reps: 3).formatted, "5 rounds + 3")
        XCTAssertEqual(SessionScore.amrap(rounds: 5, reps: 0).formatted, "5 rounds")
    }
}
