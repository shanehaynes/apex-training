import Foundation
// URLRequest lives in FoundationNetworking on Linux, not Foundation. Without this
// ApexCore does not compile there — which is the whole point of the package, so
// CI's apexcore-linux job is what catches a missing one.
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The one place the app talks to `/api/*`.
///
/// The 401 policy lives here rather than in `ApexAuth` so it is provable on
/// Linux: a 401 buys exactly one refresh and exactly one retry, and a second
/// 401 signs out. There is no loop, by construction — `perform` takes
/// `allowRefresh` and the retry passes `false`.
public actor ApexClient {
    private let baseURL: URL
    private let transport: HTTPTransport
    private let tokens: TokenProvider

    public init(baseURL: URL, transport: HTTPTransport, tokens: TokenProvider) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
    }

    public func send<T: Decodable & Sendable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        let data = try await data(for: endpoint)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(type) from \(endpoint.path): \(error)")
        }
    }

    @discardableResult
    public func data(for endpoint: Endpoint) async throws -> Data {
        try await perform(endpoint, allowRefresh: true)
    }

    /// A streaming endpoint (the coach and the workout summary): the body as it
    /// arrives, after the same 401 policy has run on the response head. A
    /// non-2xx head is read to the end and thrown as the matching `APIError`.
    public func stream(_ endpoint: Endpoint) async throws -> AsyncThrowingStream<Data, Error> {
        try await performStream(endpoint, allowRefresh: true)
    }

    /// The NDJSON coach wire, one decoded event per line, from any endpoint
    /// that speaks it (`/api/chat`, `/api/coach-summary`).
    public func wireEvents(for endpoint: Endpoint) async throws -> AsyncThrowingStream<ChatWireEvent, Error> {
        let bytes = try await stream(endpoint)
        return AsyncThrowingStream { continuation in
            let task = Task {
                var parser = NDJSONLineParser()
                do {
                    for try await chunk in bytes {
                        for line in parser.consume(chunk) { continuation.yield(try Self.decodeWire(line)) }
                    }
                    for line in parser.finish() { continuation.yield(try Self.decodeWire(line)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func decodeWire(_ line: String) throws -> ChatWireEvent {
        do {
            return try JSONDecoder().decode(ChatWireEvent.self, from: Data(line.utf8))
        } catch {
            throw APIError.decoding("wire event: \(error)")
        }
    }

    private func perform(_ endpoint: Endpoint, allowRefresh: Bool) async throws -> Data {
        let token = try await accessToken()

        let response: HTTPResponse
        do {
            response = try await transport.send(request(endpoint, token: token))
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.network("\(error)")
        }

        if (200..<300).contains(response.status) { return response.body }

        let apiError = APIError.from(
            status: response.status,
            body: response.body,
            headers: response.headers
        )
        try await refreshOnce(for: apiError, allowRefresh: allowRefresh)
        return try await perform(endpoint, allowRefresh: false)
    }

    private func performStream(_ endpoint: Endpoint, allowRefresh: Bool) async throws -> AsyncThrowingStream<Data, Error> {
        let token = try await accessToken()

        let response: HTTPStreamResponse
        do {
            response = try await transport.stream(request(endpoint, token: token))
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.network("\(error)")
        }

        if (200..<300).contains(response.status) { return response.bytes }

        // The error body is short; read it so the message survives.
        var body = Data()
        do {
            for try await chunk in response.bytes { body.append(chunk) }
        } catch {
            // The status already tells the story; a truncated error body does not change it.
        }
        let apiError = APIError.from(status: response.status, body: body, headers: response.headers)
        try await refreshOnce(for: apiError, allowRefresh: allowRefresh)
        return try await performStream(endpoint, allowRefresh: false)
    }

    /// A token the provider cannot produce because the network is down is a
    /// network failure, not a lost session — the write queue retries the former
    /// and pauses on the latter.
    private func accessToken() async throws -> String {
        do {
            return try await tokens.accessToken()
        } catch let error as URLError {
            throw APIError.network("\(error)")
        } catch {
            throw APIError.unauthorized
        }
    }

    /// The 401 policy: anything but a 401 is thrown as is; a 401 buys one
    /// refresh (or signs out); the caller then retries exactly once with
    /// `allowRefresh: false`, so a second 401 lands in the sign-out branch.
    private func refreshOnce(for apiError: APIError, allowRefresh: Bool) async throws {
        guard case .unauthorized = apiError else { throw apiError }
        guard allowRefresh else {
            // Refreshed once already and still unauthorized: the session is gone.
            await tokens.signOut()
            throw APIError.unauthorized
        }
        do {
            _ = try await tokens.refresh()
        } catch {
            await tokens.signOut()
            throw APIError.unauthorized
        }
    }

    private func request(_ endpoint: Endpoint, token: String) throws -> URLRequest {
        guard let url = endpoint.url(relativeTo: baseURL) else {
            throw APIError.decoding("could not build a URL for \(endpoint.path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = endpoint.body
        return request
    }
}
