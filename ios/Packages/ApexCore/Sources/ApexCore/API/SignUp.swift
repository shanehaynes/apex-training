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

    /// The server's own test, so the form never sends someone through the
    /// human check for an address the server will refuse: `trim()`,
    /// `toLowerCase()`, then `EMAIL_RE` (/^[^\s@]+@[^\s@]+\.[^\s@]+$/) and
    /// `MAX_EMAIL` (254 UTF-16 units) in api/_lib/handlers/signup.ts. It works
    /// on Unicode scalars with JavaScript's `\s` set, not Swift's graphemes or
    /// `isWhitespace`: those disagree with the server on U+FEFF, U+0085, a
    /// combining mark after the @, and length.
    public static func isPlausibleEmail(_ raw: String) -> Bool {
        let all = Array(raw.unicodeScalars)
        var start = all.startIndex, end = all.endIndex
        while start < end, isJSWhitespace(all[start]) { start += 1 }
        while end > start, isJSWhitespace(all[end - 1]) { end -= 1 }
        let email = String(String.UnicodeScalarView(all[start..<end])).lowercased()
        guard email.utf16.count <= 254 else { return false }
        let scalars = Array(email.unicodeScalars)
        guard !scalars.contains(where: isJSWhitespace),
              let at = scalars.firstIndex(of: "@"), scalars.lastIndex(of: "@") == at, at > 0
        else { return false }
        // `[^\s@]+\.[^\s@]+`: a dot with at least one scalar on each side.
        let domain = scalars[(at + 1)...]
        return domain.count >= 3 && domain.dropFirst().dropLast().contains(".")
    }

    /// JavaScript's `\s` (and what `String.prototype.trim` strips): the
    /// WhiteSpace and LineTerminator code points of ECMA-262.
    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
}
