import Foundation
// URLRequest lives in FoundationNetworking on Linux, not Foundation.
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Open sign-up from the app (docs/specs/open-signup.md M3).
///
/// `POST /api/signup { email, captchaToken, ageConfirmed }`, unauthenticated —
/// there is no account yet. The server answers 200 `{status: "pending"}` for
/// every address it accepts (new, already invited, throttled or a confirmed
/// account alike), so success means only "check your inbox"; the invite email
/// then lands on set-password through the app's existing hand-off.
public enum SignUp {
    public struct Request: Encodable, Sendable {
        public let email: String
        public let captchaToken: String
        public let ageConfirmed: Bool
    }

    /// The server's own sentence for a refusal, or a fallback when the body
    /// carries none; nil on success.
    public static func submit(
        email: String,
        captchaToken: String,
        ageConfirmed: Bool,
        baseURL: URL,
        transport: any HTTPTransport
    ) async -> String? {
        guard let url = Endpoint(path: "api/signup").url(relativeTo: baseURL) else {
            return fallback
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(Request(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            captchaToken: captchaToken,
            ageConfirmed: ageConfirmed
        ))
        do {
            let response = try await transport.send(request)
            if (200..<300).contains(response.status) { return nil }
            struct Refusal: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(Refusal.self, from: response.body))?.error
            return message?.isEmpty == false ? message : fallback
        } catch {
            return "Could not reach Apex — check your connection."
        }
    }

    static let fallback = "Sign-up failed — try again later."

    /// The server's own test (`EMAIL_RE` and `MAX_EMAIL` in
    /// api/_lib/handlers/signup.ts), so the form never sends someone through
    /// the human check for an address the server will refuse.
    public static func isPlausibleEmail(_ raw: String) -> Bool {
        let email = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard email.count <= 254, !email.contains(where: \.isWhitespace) else { return false }
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        // `[^\s@]+\.[^\s@]+`: a dot with at least one character on each side.
        let domain = Array(parts[1])
        return domain.count >= 3 && domain.dropFirst().dropLast().contains(".")
    }
}
