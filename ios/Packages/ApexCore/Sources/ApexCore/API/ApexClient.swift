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

    private func perform(_ endpoint: Endpoint, allowRefresh: Bool) async throws -> Data {
        let token: String
        do {
            token = try await tokens.accessToken()
        } catch {
            throw APIError.unauthorized
        }

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
        return try await perform(endpoint, allowRefresh: false)
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
