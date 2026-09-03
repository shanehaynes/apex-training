import XCTest
@testable import ApexCore

final class APIErrorTests: XCTestCase {
    private func map(_ status: Int, body: String = "", headers: [String: String] = [:]) -> APIError {
        APIError.from(status: status, body: Data(body.utf8), headers: headers)
    }

    func testMapsAuthAndCoachStatuses() {
        XCTAssertEqual(map(401), .unauthorized)
        XCTAssertEqual(map(402), .missingAnthropicKey)
        XCTAssertEqual(map(413), .payloadTooLarge)
    }

    /// 403 only means "accept the terms" when the body says so; other 403s are
    /// ordinary server errors and must not send the user to the terms screen.
    func testTermsAcceptanceNeedsTheBodyMarker() {
        XCTAssertEqual(
            map(403, body: #"{"error":"terms-acceptance-required"}"#),
            .termsAcceptanceRequired
        )
        XCTAssertEqual(map(403, body: #"{"error":"forbidden"}"#), .server(status: 403, message: "forbidden"))
    }

    func testRateLimitCarriesRetryAfter() {
        XCTAssertEqual(map(429, headers: ["Retry-After": "30"]), .rateLimited(retryAfter: 30))
        // Header casing is the server's choice, not ours.
        XCTAssertEqual(map(429, headers: ["retry-after": "12"]), .rateLimited(retryAfter: 12))
        XCTAssertEqual(map(429), .rateLimited(retryAfter: nil))
    }

    func testServerErrorPrefersTheApiErrorField() {
        XCTAssertEqual(map(500, body: #"{"error":"boom"}"#), .server(status: 500, message: "boom"))
        XCTAssertEqual(map(500, body: "<html>502</html>"), .server(status: 500, message: "<html>502</html>"))
        XCTAssertEqual(map(500), .server(status: 500, message: nil))
    }
}
