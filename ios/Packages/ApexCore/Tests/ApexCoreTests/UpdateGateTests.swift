import XCTest
import Foundation
// URLRequest lives in FoundationNetworking on Linux, not Foundation. Without this
// ApexCore does not compile there — which is the whole point of the package, so
// CI's apexcore-linux job is what catches a missing one.
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import ApexCore

/// The client half of G8: the header every request carries, and the launch
/// check that decides whether this build may keep running. Both live in
/// ApexCore so they are provable on Linux rather than only in a simulator.
final class UpdateGateTests: XCTestCase {
    private actor FakeTokens: TokenProvider {
        func accessToken() async throws -> String { "t1" }
        func refresh() async throws -> String { "t1" }
        func signOut() async {}
    }

    private actor RecordingTransport: HTTPTransport {
        private let response: HTTPResponse
        private(set) var requests: [URLRequest] = []

        init(_ response: HTTPResponse = HTTPResponse(status: 200, body: Data("{}".utf8))) {
            self.response = response
        }

        func send(_ request: URLRequest) async throws -> HTTPResponse {
            requests.append(request)
            return response
        }

        func header(_ name: String) -> String? { requests.first?.value(forHTTPHeaderField: name) }
    }

    private actor FailingTransport: HTTPTransport {
        func send(_ request: URLRequest) async throws -> HTTPResponse { throw APIError.network("down") }
    }

    private func client(_ transport: RecordingTransport, tag: String?) -> ApexClient {
        ApexClient(
            baseURL: URL(string: "http://127.0.0.1:5314")!,
            transport: transport,
            tokens: FakeTokens(),
            clientTag: tag
        )
    }

    // MARK: - The header

    func testRequestsCarryTheClientTag() async throws {
        let transport = RecordingTransport()
        _ = try await client(transport, tag: ClientTag.ios(version: "0.6.0", build: "312")).data(for: .profile)
        let sent = await transport.header(ClientTag.header)
        XCTAssertEqual(sent, "ios/0.6.0+312")
    }

    /// Nil is the default every test and preview builds with; it must send no
    /// header rather than an empty or invented one.
    func testNoTagMeansNoHeader() async throws {
        let transport = RecordingTransport()
        _ = try await client(transport, tag: nil).data(for: .profile)
        let sent = await transport.header(ClientTag.header)
        XCTAssertNil(sent)
    }

    func testTheTagRidesTheRetryToo() async throws {
        let transport = RecordingTransport(HTTPResponse(status: 200, body: Data("{}".utf8)))
        _ = try await client(transport, tag: "ios/0.6.0+312").data(for: .profile)
        let headers = await transport.requests.map { $0.value(forHTTPHeaderField: ClientTag.header) }
        XCTAssertEqual(headers, ["ios/0.6.0+312"])
    }

    func testBuildNumberIsTheIntegerOrZero() {
        XCTAssertEqual(ClientTag.buildNumber("312"), 312)
        XCTAssertEqual(ClientTag.buildNumber(" 312 "), 312)
        XCTAssertEqual(ClientTag.buildNumber("1.2.3"), 0)
        XCTAssertEqual(ClientTag.buildNumber(""), 0)
    }

    // MARK: - The verdict

    func testBelowTheFloorIsBlocked() {
        let verdict = UpdateGate.verdict(build: 311, info: VersionInfo(sha: "abc", minBuild: 312))
        XCTAssertEqual(verdict, UpdateGate.defaultMessage)
    }

    func testTheFloorItselfIsServed() {
        XCTAssertNil(UpdateGate.verdict(build: 312, info: VersionInfo(sha: "abc", minBuild: 312)))
        XCTAssertNil(UpdateGate.verdict(build: 400, info: VersionInfo(sha: "abc", minBuild: 312)))
    }

    /// The default until Shane sets one: no floor gates nothing.
    func testZeroFloorNeverBlocks() {
        XCTAssertNil(UpdateGate.verdict(build: 1, info: VersionInfo(sha: "abc", minBuild: 0)))
    }

    /// An unreadable CFBundleVersion must not lock the app — fail open.
    func testUnreadableBuildNeverBlocks() {
        XCTAssertNil(UpdateGate.verdict(build: 0, info: VersionInfo(sha: "abc", minBuild: 312)))
    }

    func testTheDeploymentsMessageWinsWhenItHasOne() {
        let info = VersionInfo(sha: "abc", minBuild: 312, message: "Sign-in changed.")
        XCTAssertEqual(UpdateGate.verdict(build: 311, info: info), "Sign-in changed.")
    }

    func testAnEmptyMessageFallsBackToTheDefault() {
        let info = VersionInfo(sha: "abc", minBuild: 312, message: "   ")
        XCTAssertEqual(UpdateGate.verdict(build: 311, info: info), UpdateGate.defaultMessage)
    }

    // MARK: - The read

    func testFetchDecodesTheBody() async {
        let body = Data(#"{"sha":"abc","minBuild":312,"message":"Update."}"#.utf8)
        let transport = RecordingTransport(HTTPResponse(status: 200, body: body))
        let info = await UpdateGate.fetch(baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport)
        XCTAssertEqual(info, VersionInfo(sha: "abc", minBuild: 312, message: "Update."))
        let path = await transport.requests.first?.url?.path
        XCTAssertEqual(path, "/api/version")
    }

    /// The check is unauthenticated: the handler asks for no token, and a
    /// launch that is not signed in yet still has to get an answer.
    func testTheReadSendsNoAuthorization() async {
        let transport = RecordingTransport(HTTPResponse(status: 200, body: Data(#"{"sha":"abc"}"#.utf8)))
        _ = await UpdateGate.fetch(baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport)
        let sent = await transport.header("Authorization")
        XCTAssertNil(sent)
    }

    /// A deployment older than the gate answers `{ sha }` alone. That is "no
    /// floor", not a decode failure.
    func testAMissingMinBuildReadsAsNoFloor() async {
        let transport = RecordingTransport(HTTPResponse(status: 200, body: Data(#"{"sha":"abc"}"#.utf8)))
        let info = await UpdateGate.fetch(baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport)
        XCTAssertEqual(info, VersionInfo(sha: "abc", minBuild: 0))
    }

    func testAnOfflineLaunchIsNotBlocked() async {
        let verdict = await UpdateGate.check(
            build: 1,
            baseURL: URL(string: "http://127.0.0.1:5314")!,
            transport: FailingTransport()
        )
        XCTAssertNil(verdict)
    }

    func testAServerErrorIsNotBlocked() async {
        let transport = RecordingTransport(HTTPResponse(status: 500))
        let verdict = await UpdateGate.check(
            build: 1, baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport
        )
        XCTAssertNil(verdict)
    }

    func testAnUnparseableBodyIsNotBlocked() async {
        let transport = RecordingTransport(HTTPResponse(status: 200, body: Data("not json".utf8)))
        let verdict = await UpdateGate.check(
            build: 1, baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport
        )
        XCTAssertNil(verdict)
    }

    func testCheckBlocksAnOldBuild() async {
        let body = Data(#"{"sha":"abc","minBuild":312}"#.utf8)
        let transport = RecordingTransport(HTTPResponse(status: 200, body: body))
        let verdict = await UpdateGate.check(
            build: 311, baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport
        )
        XCTAssertEqual(verdict, UpdateGate.defaultMessage)
    }
}
