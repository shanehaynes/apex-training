import Foundation

/// `GET /api/profile`.
public struct ProfileResponse: Codable, Sendable, Equatable {
    public let hasAnthropicKey: Bool
    public let anthropicKeyLast4: String?
    public let termsAccepted: TermsAcceptance?
    public let termsCurrent: Bool

    public struct TermsAcceptance: Codable, Sendable, Equatable {
        public let termsVersion: String?
        public let privacyVersion: String?
        public let acceptedAt: String?
    }
}

/// `GET /api/query?tool=…` wraps every read-only coach tool in the same envelope.
public struct QueryEnvelope<Result: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public let tool: String
    public let result: Result
}

/// `POST /api/coach-tool` (W5b).
public struct CoachToolResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let resultText: String?
    public let problem: String?
}
