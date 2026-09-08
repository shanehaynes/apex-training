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

    func testUnauthorizedPauses() {
        XCTAssertEqual(policy.classify(.unauthorized, attempts: 0), .pause)
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
