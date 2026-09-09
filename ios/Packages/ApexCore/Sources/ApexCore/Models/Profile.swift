import Foundation

/// `GET /api/profile`.
public struct ProfileResponse: Codable, Sendable, Equatable {
    public let hasAnthropicKey: Bool
    public let anthropicKeyLast4: String?
    public let termsAccepted: TermsAcceptance?
    public let termsCurrent: Bool
    /// The stored `profiles.coach_model` (nil = follow the default) and the
    /// label of the model that will actually run, resolved server-side (W6).
    /// Optional because a profile cached by an older build must still decode.
    public let coachModel: String?
    public let coachModelLabel: String?

    public init(
        hasAnthropicKey: Bool, anthropicKeyLast4: String?, termsAccepted: TermsAcceptance?,
        termsCurrent: Bool, coachModel: String? = nil, coachModelLabel: String? = nil
    ) {
        self.hasAnthropicKey = hasAnthropicKey
        self.anthropicKeyLast4 = anthropicKeyLast4
        self.termsAccepted = termsAccepted
        self.termsCurrent = termsCurrent
        self.coachModel = coachModel
        self.coachModelLabel = coachModelLabel
    }

    public struct TermsAcceptance: Codable, Sendable, Equatable {
        public let termsVersion: String?
        public let privacyVersion: String?
        public let acceptedAt: String?

        public init(termsVersion: String?, privacyVersion: String?, acceptedAt: String?) {
            self.termsVersion = termsVersion
            self.privacyVersion = privacyVersion
            self.acceptedAt = acceptedAt
        }
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
