import Foundation
// URLRequest lives in FoundationNetworking on Linux, not Foundation. Without this
// ApexCore does not compile there — which is the whole point of the package, so
// CI's apexcore-linux job is what catches a missing one.
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

/// A response whose body arrives in chunks — the coach streams.
public struct HTTPStreamResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let bytes: AsyncThrowingStream<Data, Error>

    public init(status: Int, headers: [String: String] = [:], bytes: AsyncThrowingStream<Data, Error>) {
        self.status = status
        self.headers = headers
        self.bytes = bytes
    }

    /// A whole body as a one-chunk stream.
    public init(_ response: HTTPResponse) {
        self.init(status: response.status, headers: response.headers, bytes: AsyncThrowingStream { continuation in
            continuation.yield(response.body)
            continuation.finish()
        })
    }
}

/// The seam that keeps `ApexClient` testable — and Linux-buildable, since
/// `URLSession`'s async API is not fully available in corelibs-foundation.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPResponse
    /// Chunked delivery for streaming endpoints. The default answers with the
    /// whole `send` body in one chunk, so a fake that only scripts `send` still
    /// exercises the streaming code path.
    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse
}

public extension HTTPTransport {
    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        HTTPStreamResponse(try await send(request))
    }
}
