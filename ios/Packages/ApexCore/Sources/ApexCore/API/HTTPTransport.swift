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

/// The seam that keeps `ApexClient` testable — and Linux-buildable, since
/// `URLSession`'s async API is not fully available in corelibs-foundation.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPResponse
}
