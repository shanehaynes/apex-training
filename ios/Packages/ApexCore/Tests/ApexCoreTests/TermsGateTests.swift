import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import ApexCore

/// W16 MT: a signed-in user meets the terms gate on whichever request comes
/// first after a new version is published. The client announces it once per
/// meeting, throws as before, and never treats it as a lost session.
final class TermsGateTests: XCTestCase {
    private actor Transport: HTTPTransport {
        private var responses: [HTTPResponse]
        init(_ responses: [HTTPResponse]) { self.responses = responses }
        func send(_ request: URLRequest) async throws -> HTTPResponse {
            responses.isEmpty ? HTTPResponse(status: 500) : responses.removeFirst()
        }
    }

    private actor Tokens: TokenProvider {
        private(set) var refreshes = 0
        private(set) var signOuts = 0
        func accessToken() async throws -> String { "t" }
        func refresh() async throws -> String { refreshes += 1; return "t" }
        func signOut() async { signOuts += 1 }
    }

    private func make(_ responses: [HTTPResponse]) -> (ApexClient, Tokens) {
        let tokens = Tokens()
        return (ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: Transport(responses), tokens: tokens), tokens)
    }

    func testTheGateIsAnnouncedAndThrownWithoutTouchingTheSession() async throws {
        let (client, tokens) = make([HTTPResponse(status: 403, body: Data("terms-acceptance-required".utf8))])
        do {
            _ = try await client.data(for: .profile)
            XCTFail("expected the gate")
        } catch let error as APIError {
            XCTAssertEqual(error, .termsAcceptanceRequired)
        }
        var notices = client.notices.makeAsyncIterator()
        let notice = await notices.next()
        XCTAssertEqual(notice, .termsAcceptanceRequired)
        let refreshes = await tokens.refreshes
        let signOuts = await tokens.signOuts
        XCTAssertEqual(refreshes, 0, "the gate is consent, not an expired token")
        XCTAssertEqual(signOuts, 0)
    }

    func testOtherFailuresAnnounceNothing() async throws {
        let (client, _) = make([
            HTTPResponse(status: 403, body: Data("Forbidden".utf8)),
            HTTPResponse(status: 200, body: Data("{}".utf8)),
        ])
        _ = try? await client.data(for: .profile)
        _ = try await client.data(for: .profile)
        var notices = client.notices.makeAsyncIterator()
        let pending = Task { await notices.next() }
        try await Task.sleep(for: .milliseconds(50))
        pending.cancel()
        let notice = await pending.value
        XCTAssertNil(notice, "a plain 403 and a success are the caller's business")
    }

    func testStatusDecodesWithAndWithoutTheVersions() throws {
        let read = try JSONDecoder().decode(TermsStatus.self, from: Data(#"""
        {"accepted":{"termsVersion":"terms-v1","privacyVersion":"privacy-v1","acceptedAt":"2026-08-29T12:00:00.000Z"},
         "current":false,"termsVersion":"terms-v1","privacyVersion":"privacy-v2"}
        """#.utf8))
        XCTAssertFalse(read.current)
        XCTAssertEqual(read.accepted?.privacyVersion, "privacy-v1")
        XCTAssertEqual(read.privacyVersion, "privacy-v2")
        let recorded = try JSONDecoder().decode(TermsStatus.self, from: Data(#"{"accepted":null,"current":true}"#.utf8))
        XCTAssertTrue(recorded.current)
        XCTAssertNil(recorded.termsVersion)
        XCTAssertEqual(Endpoint.termsStatus.method, .get)
        XCTAssertEqual(Endpoint.termsStatus.path, "api/terms-acceptance")
    }
}
