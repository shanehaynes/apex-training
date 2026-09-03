import Foundation

/// Every way an `/api/*` call can fail, mapped from the status codes the web
/// client already handles (src/hooks/useChat.ts, api/_lib/auth.ts).
public enum APIError: Error, Equatable, Sendable {
    case unauthorized
    /// 402 — the user has not saved an Anthropic key. The coach surfaces this
    /// inline with a setup prompt; it is never a toast.
    case missingAnthropicKey
    /// 403 with body `terms-acceptance-required` — `requireUser` gates every
    /// non-exempt route until the current Terms/Privacy are accepted.
    case termsAcceptanceRequired
    case payloadTooLarge
    case rateLimited(retryAfter: Double?)
    case server(status: Int, message: String?)
    case network(String)
    case decoding(String)

    /// Maps a response to an error. Pure, so the whole table is unit-tested on Linux.
    public static func from(status: Int, body: Data, headers: [String: String]) -> APIError {
        let text = String(data: body, encoding: .utf8) ?? ""
        switch status {
        case 401:
            return .unauthorized
        case 402:
            return .missingAnthropicKey
        case 403 where text.contains("terms-acceptance-required"):
            return .termsAcceptanceRequired
        case 413:
            return .payloadTooLarge
        case 429:
            return .rateLimited(retryAfter: retryAfterSeconds(headers))
        default:
            return .server(status: status, message: message(from: body) ?? nonEmpty(text))
        }
    }

    /// Header lookup is case-insensitive: URLSession preserves the server's casing,
    /// and Vercel does not promise `Retry-After` over `retry-after`.
    private static func retryAfterSeconds(_ headers: [String: String]) -> Double? {
        for (key, value) in headers where key.lowercased() == "retry-after" {
            return Double(value.trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    /// The API's error shape is `{ "error": "..." }`.
    private static func message(from body: Data) -> String? {
        guard
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let error = object["error"] as? String
        else { return nil }
        return nonEmpty(error)
    }

    private static func nonEmpty(_ s: String) -> String? {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension APIError: CustomStringConvertible {
    public var description: String {
        switch self {
        case .unauthorized: "Session expired. Sign in again."
        case .missingAnthropicKey: "Add an Anthropic API key to use the coach."
        case .termsAcceptanceRequired: "Accept the updated terms to continue."
        case .payloadTooLarge: "That request was too large."
        case .rateLimited(let retryAfter):
            retryAfter.map { "Too many requests. Try again in \(Int($0.rounded(.up)))s." }
                ?? "Too many requests. Try again shortly."
        case .server(let status, let message): message ?? "Server error (\(status))."
        case .network: "No connection."
        case .decoding: "The server sent something unexpected."
        }
    }
}
