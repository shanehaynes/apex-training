import XCTest
import Foundation
// URLRequest lives in FoundationNetworking on Linux, not Foundation. Without this
// ApexCore does not compile there — which is the whole point of the package, so
// CI's apexcore-linux job is what catches a missing one.
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import ApexCore

/// The 401 policy, which must never loop. These run on Linux, which is the whole
/// reason the policy lives in ApexCore instead of ApexAuth.
final class ApexClientAuthTests: XCTestCase {
    private actor FakeTokens: TokenProvider {
        private var tokens: [String]
        private(set) var refreshCount = 0
        private(set) var signOutCount = 0
        private let refreshFails: Bool

        init(tokens: [String] = ["t1", "t2"], refreshFails: Bool = false) {
            self.tokens = tokens
            self.refreshFails = refreshFails
        }

        func accessToken() async throws -> String { tokens.first ?? "t1" }

        func refresh() async throws -> String {
            refreshCount += 1
            if refreshFails { throw APIError.unauthorized }
            if tokens.count > 1 { tokens.removeFirst() }
            return tokens.first ?? "t1"
        }

        func signOut() async { signOutCount += 1 }
    }

    private actor FakeTransport: HTTPTransport {
        private var responses: [HTTPResponse]
        private(set) var sentAuthorization: [String] = []

        init(_ responses: [HTTPResponse]) { self.responses = responses }

        var callCount: Int { sentAuthorization.count }

        func send(_ request: URLRequest) async throws -> HTTPResponse {
            sentAuthorization.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
            return responses.isEmpty ? HTTPResponse(status: 500) : responses.removeFirst()
        }
    }

    private func client(_ transport: FakeTransport, _ tokens: FakeTokens) -> ApexClient {
        ApexClient(baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport, tokens: tokens)
    }

    func testSuccessSendsTheBearerToken() async throws {
        let transport = FakeTransport([HTTPResponse(status: 200, body: Data("{}".utf8))])
        let tokens = FakeTokens()
        _ = try await client(transport, tokens).data(for: .profile)
        let sent = await transport.sentAuthorization
        XCTAssertEqual(sent, ["Bearer t1"])
        let refreshes = await tokens.refreshCount
        XCTAssertEqual(refreshes, 0)
    }

    func testUnauthorizedRefreshesOnceAndRetriesOnce() async throws {
        let transport = FakeTransport([
            HTTPResponse(status: 401),
            HTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8)),
        ])
        let tokens = FakeTokens()

        _ = try await client(transport, tokens).data(for: .profile)

        let refreshes = await tokens.refreshCount
        let signOuts = await tokens.signOutCount
        let sent = await transport.sentAuthorization
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(signOuts, 0)
        // The retry carries the *new* token — a retry with the stale one would
        // 401 forever.
        XCTAssertEqual(sent, ["Bearer t1", "Bearer t2"])
    }

    /// The never-loop assertion: a second 401 signs out rather than refreshing again.
    func testSecondUnauthorizedSignsOutAndStops() async throws {
        let transport = FakeTransport([HTTPResponse(status: 401), HTTPResponse(status: 401)])
        let tokens = FakeTokens()

        do {
            _ = try await client(transport, tokens).data(for: .profile)
            XCTFail("expected .unauthorized")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
        }

        let refreshes = await tokens.refreshCount
        let signOuts = await tokens.signOutCount
        let calls = await transport.callCount
        XCTAssertEqual(refreshes, 1, "refresh must be attempted exactly once")
        XCTAssertEqual(signOuts, 1)
        XCTAssertEqual(calls, 2, "one original request and exactly one retry")
    }

    func testFailedRefreshSignsOutWithoutRetrying() async throws {
        let transport = FakeTransport([HTTPResponse(status: 401)])
        let tokens = FakeTokens(refreshFails: true)

        do {
            _ = try await client(transport, tokens).data(for: .profile)
            XCTFail("expected .unauthorized")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
        }

        let signOuts = await tokens.signOutCount
        let calls = await transport.callCount
        XCTAssertEqual(signOuts, 1)
        XCTAssertEqual(calls, 1, "a failed refresh must not retry the request")
    }

    /// Non-401 failures are returned as-is: no refresh, no sign-out.
    func testOtherErrorsPassThroughUntouched() async throws {
        let transport = FakeTransport([HTTPResponse(status: 429, headers: ["Retry-After": "5"])])
        let tokens = FakeTokens()

        do {
            _ = try await client(transport, tokens).data(for: .profile)
            XCTFail("expected .rateLimited")
        } catch let error as APIError {
            XCTAssertEqual(error, .rateLimited(retryAfter: 5))
        }

        let refreshes = await tokens.refreshCount
        let signOuts = await tokens.signOutCount
        XCTAssertEqual(refreshes, 0)
        XCTAssertEqual(signOuts, 0)
    }

    func testDecodingFailureIsReportedAsDecoding() async throws {
        let transport = FakeTransport([HTTPResponse(status: 200, body: Data("not json".utf8))])
        do {
            _ = try await client(transport, FakeTokens()).send(.profile, as: ProfileResponse.self)
            XCTFail("expected .decoding")
        } catch let error as APIError {
            guard case .decoding = error else { return XCTFail("got \(error)") }
        }
    }
}
