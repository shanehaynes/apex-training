import ApexCore
import Foundation

/// The one `URLSession` in the app. It lives in the app target rather than
/// `ApexCore` so `ApexCore` stays free of Apple networking and buildable on Linux.
struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.network("not an HTTP response")
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            return HTTPResponse(status: http.statusCode, headers: headers, body: data)
        } catch let error as URLError {
            throw APIError.network(error.localizedDescription)
        }
    }
}
