import XCTest
@testable import ApexCore

final class RetryPolicyTests: XCTestCase {
    private let policy = RetryPolicy()

    func testBackoffDoublesFromOneSecondAndCaps() {
        XCTAssertEqual((0..<5).map(policy.backoff), [1, 2, 4, 8, 16])
        XCTAssertEqual(policy.backoff(attempts: 20), 300)
    }

    func testTransientFailuresRetry() {
        XCTAssertEqual(policy.classify(.network("offline"), attempts: 0), .retry(after: 1))
        XCTAssertEqual(policy.classify(.server(status: 503, message: nil), attempts: 2), .retry(after: 4))
        XCTAssertEqual(policy.classify(.rateLimited(retryAfter: 7), attempts: 0), .retry(after: 7))
        XCTAssertEqual(policy.classify(.rateLimited(retryAfter: nil), attempts: 1), .retry(after: 2))
    }

    func testTransientFailuresStopRetryingAtTheCeiling() {
        // The last retry the default policy grants is the eighth failure's.
        XCTAssertEqual(policy.classify(.server(status: 500, message: nil), attempts: 7), .retry(after: 128))
        // The ninth is permanent, so a server that 500s forever cannot hold the
        // session's FIFO open indefinitely.
        XCTAssertEqual(
            policy.classify(.server(status: 500, message: nil), attempts: 8),
            .fail("Could not sync after 9 attempts. Server error (500).")
        )
        XCTAssertEqual(
            policy.classify(.network("offline"), attempts: 8),
            .fail("Could not sync after 9 attempts. No connection.")
        )
        // Even a `Retry-After` the server keeps sending runs out of retries.
        XCTAssertEqual(
            policy.classify(.rateLimited(retryAfter: 7), attempts: 9),
            .fail("Could not sync after 10 attempts. Too many requests. Try again in 7s.")
        )
    }

    func testTheCeilingIsConfigurable() {
        let short = RetryPolicy(maxAttempts: 2)
        XCTAssertEqual(short.classify(.network("offline"), attempts: 1), .retry(after: 2))
        XCTAssertEqual(short.classify(.network("offline"), attempts: 2), .fail("Could not sync after 3 attempts. No connection."))
        // Zero means never retry a transient failure at all.
        XCTAssertEqual(RetryPolicy(maxAttempts: 0).classify(.network("offline"), attempts: 0), .fail("Could not sync after 1 attempts. No connection."))
    }

    func testUnauthorizedPausesNoMatterHowManyAttempts() {
        XCTAssertEqual(policy.classify(.unauthorized, attempts: 0), .pause)
        // A pause is not an attempt the queue can exhaust: the op waits for an
        // external trigger, it does not fail.
        XCTAssertEqual(policy.classify(.unauthorized, attempts: 99), .pause)
    }

    func testEverythingElseIsPermanent() {
        XCTAssertEqual(policy.classify(.server(status: 400, message: "Invalid score"), attempts: 0), .fail("Invalid score"))
        XCTAssertEqual(policy.classify(.server(status: 404, message: nil), attempts: 0), .fail("Server error (404)."))
        XCTAssertEqual(policy.classify(.payloadTooLarge, attempts: 0), .fail(APIError.payloadTooLarge.description))
        XCTAssertEqual(policy.classify(.termsAcceptanceRequired, attempts: 0), .fail(APIError.termsAcceptanceRequired.description))
        XCTAssertEqual(policy.classify(.decoding("x"), attempts: 0), .fail(APIError.decoding("x").description))
    }

    func testTimestampWindowRejection() {
        XCTAssertTrue(RetryPolicy.isTimestampWindowRejection(.server(status: 400, message: "startedAt must be an ISO timestamp within the last 7 days")))
        XCTAssertFalse(RetryPolicy.isTimestampWindowRejection(.server(status: 400, message: "Invalid score")))
        XCTAssertFalse(RetryPolicy.isTimestampWindowRejection(.server(status: 500, message: "within the last 7 days")))
        XCTAssertEqual(TrackerOpPayload.start(startedAt: "2026-01-01T00:00:00.000Z").strippingClientTimestamp(), .start(startedAt: nil))
        XCTAssertNil(TrackerOpPayload.start(startedAt: nil).strippingClientTimestamp())
        XCTAssertEqual(
            TrackerOpPayload.finish(FinishPayload(autofillRows: [], finishedAt: "x")).strippingClientTimestamp(),
            .finish(FinishPayload(autofillRows: [], finishedAt: nil))
        )
        XCTAssertNil(TrackerOpPayload.cancel.strippingClientTimestamp())
    }
}
