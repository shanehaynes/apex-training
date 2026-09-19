import XCTest
@testable import ApexCore

final class RealtimeJoinRetryTests: XCTestCase {
    private let retry = RealtimeJoinRetry.default

    func testDelaysMatchTheWriteQueueCurve() {
        let policy = RetryPolicy.default
        XCTAssertEqual(retry.step(afterFailures: 1), .retry(after: policy.backoff(attempts: 0)))
        XCTAssertEqual(
            (1..<retry.maxAttempts).map { retry.step(afterFailures: $0) },
            [1, 2, 4, 8, 16].map { RealtimeJoinRetry.Step.retry(after: $0) }
        )
    }

    func testGivesUpAfterTheLastAttempt() {
        XCTAssertEqual(retry.step(afterFailures: retry.maxAttempts), .giveUp)
        XCTAssertEqual(retry.step(afterFailures: retry.maxAttempts + 5), .giveUp)
    }

    func testBoundedByItsPolicysCap() {
        let long = RealtimeJoinRetry(maxAttempts: 40, policy: RetryPolicy(baseDelay: 1, maxDelay: 30))
        XCTAssertEqual(long.step(afterFailures: 6), .retry(after: 30))
        XCTAssertEqual(long.step(afterFailures: 39), .retry(after: 30))
    }

    func testNonsenseFailureCountStillWaitsTheBaseDelay() {
        XCTAssertEqual(retry.step(afterFailures: 0), .retry(after: 1))
        XCTAssertEqual(retry.step(afterFailures: -3), .retry(after: 1))
    }

    func testAvailabilityIsDegradedOnlyWithAGroupInIt() {
        XCTAssertFalse(RealtimeAvailability.live.isDegraded)
        XCTAssertTrue(RealtimeAvailability(unavailable: [.schedule]).isDegraded)
        XCTAssertEqual(RealtimeAvailability(unavailable: []), .live)
    }
}
