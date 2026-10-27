import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import ApexCore

/// The app's half of open sign-up: what it sends to /api/signup and how it
/// reads the answer. The server's half is api/__tests__/signup.test.ts.
final class SignUpTests: XCTestCase {
    private actor Transport: HTTPTransport {
        private let response: HTTPResponse?
        private(set) var requests: [URLRequest] = []
        init(_ response: HTTPResponse?) { self.response = response }
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            requests.append(request)
            guard let response else { throw APIError.network("down") }
            return response
        }
    }

    private let base = URL(string: "https://apex-training.app")!

    func testSendsTheTokenAndTheAttestationAsJSON() async throws {
        let transport = Transport(HTTPResponse(status: 200, body: Data(#"{"status":"pending"}"#.utf8)))
        let problem = await SignUp.submit(
            email: "  someone@example.com ", captchaToken: "tok", ageConfirmed: true,
            baseURL: base, transport: transport
        )
        XCTAssertNil(problem)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://apex-training.app/api/signup")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "no account yet, so no token")
        // Without it Vercel leaves req.body a string, and the handler refuses the address.
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["email"] as? String, "someone@example.com")
        XCTAssertEqual(sent["captchaToken"] as? String, "tok")
        // A JSON boolean: the server refuses "true" and 1.
        XCTAssertEqual(sent["ageConfirmed"] as? Bool, true)
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains(#""ageConfirmed":true"#))
    }

    func testShowsTheServersOwnRefusal() async {
        let transport = Transport(HTTPResponse(status: 400, body: Data(#"{"error":"The human check failed — try again."}"#.utf8)))
        let problem = await SignUp.submit(email: "a@b.co", captchaToken: "t", ageConfirmed: true, baseURL: base, transport: transport)
        XCTAssertEqual(problem, "The human check failed — try again.")
    }

    func testFallsBackWhenTheBodySaysNothing() async {
        let transport = Transport(HTTPResponse(status: 503, body: Data("<html>".utf8)))
        let problem = await SignUp.submit(email: "a@b.co", captchaToken: "t", ageConfirmed: true, baseURL: base, transport: transport)
        XCTAssertEqual(problem, SignUp.fallback)
    }

    /// The server's `EMAIL_RE` (/^[^\s@]+@[^\s@]+\.[^\s@]+$/) and 254-character
    /// cap, case by case: the form must agree with it in both directions.
    func testEmailRuleMatchesTheServers() {
        for accepted in ["someone@example.com", "  someone@example.com\n", "a@b.c", "jane.doe+x@mail.co.uk", "a@b..c"] {
            XCTAssertTrue(SignUp.isPlausibleEmail(accepted), accepted)
        }
        for refused in ["", "someone", "jane.doe@gmail", "jane doe@gmail.com", "a@@b.com", "a@b@c.com",
                        "@example.com", "a@.com", "a@com.", "a@b .com", "a@b.c\td"] {
            XCTAssertFalse(SignUp.isPlausibleEmail(refused), refused)
        }
        let long = String(repeating: "a", count: 243) + "@example.com"   // 255 characters
        XCTAssertFalse(SignUp.isPlausibleEmail(long))
        XCTAssertTrue(SignUp.isPlausibleEmail(String(long.dropFirst())))
    }

    func testOfflineSaysSo() async {
        let problem = await SignUp.submit(email: "a@b.co", captchaToken: "t", ageConfirmed: true, baseURL: base, transport: Transport(nil))
        XCTAssertEqual(problem, "Could not reach Apex — check your connection.")
    }
}
