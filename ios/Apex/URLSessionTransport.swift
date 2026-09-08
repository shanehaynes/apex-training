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

    /// Chunked delivery for the coach streams: the body as `URLSession` hands it
    /// over, so a summary renders while the model is still writing it.
    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.network("not an HTTP response")
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            let chunks = AsyncThrowingStream<Data, Error> { continuation in
                let task = Task {
                    do {
                        // Line-sized chunks: the NDJSON parser re-splits anyway, and
                        // a line is the smallest unit that renders anything.
                        for try await line in bytes.lines {
                            continuation.yield(Data((line + "\n").utf8))
                        }
                        continuation.finish()
                    } catch let error as URLError {
                        continuation.finish(throwing: APIError.network(error.localizedDescription))
                    } catch {
                        continuation.finish(throwing: error)
                    }
                }
                continuation.onTermination = { _ in task.cancel() }
            }
            return HTTPStreamResponse(status: http.statusCode, headers: headers, bytes: chunks)
        } catch let error as URLError {
            throw APIError.network(error.localizedDescription)
        }
    }
}
