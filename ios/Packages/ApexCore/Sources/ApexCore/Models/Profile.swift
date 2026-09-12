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

    // W11 widened the response to the rest of the `profiles` row, so the You
    // tab reads one endpoint instead of the table. All optional for the same
    // reason as the W6 pair: a response cached by an older build still decodes.
    public let displayName: String?
    public let avatarKey: String?
    /// Free text the coach is given. `""` is a real value — the user cleared it.
    public let coachGoal: String?
    public let coachContext: String?
    public let maxHr: Int?
    public let thresholdHr: Int?
    /// The ICS feed, composed server-side from the profile's `ics_token`. nil
    /// when the row has no token yet. `webcal://` is the same URL with the
    /// scheme swapped — the server only ever serves the https spelling.
    public let calendarFeedUrl: String?
    /// The picker's options, server-owned so no client hand-ports the catalog
    /// (D-008). Ordered most → least capable, which is also a cost ladder.
    public let coachModels: [CoachModelOption]?

    public init(
        hasAnthropicKey: Bool, anthropicKeyLast4: String?, termsAccepted: TermsAcceptance?,
        termsCurrent: Bool, coachModel: String? = nil, coachModelLabel: String? = nil,
        displayName: String? = nil, avatarKey: String? = nil,
        coachGoal: String? = nil, coachContext: String? = nil,
        maxHr: Int? = nil, thresholdHr: Int? = nil,
        calendarFeedUrl: String? = nil, coachModels: [CoachModelOption]? = nil
    ) {
        self.hasAnthropicKey = hasAnthropicKey
        self.anthropicKeyLast4 = anthropicKeyLast4
        self.termsAccepted = termsAccepted
        self.termsCurrent = termsCurrent
        self.coachModel = coachModel
        self.coachModelLabel = coachModelLabel
        self.displayName = displayName
        self.avatarKey = avatarKey
        self.coachGoal = coachGoal
        self.coachContext = coachContext
        self.maxHr = maxHr
        self.thresholdHr = thresholdHr
        self.calendarFeedUrl = calendarFeedUrl
        self.coachModels = coachModels
    }

    /// One entry of the coach model catalog (`src/lib/coach/models.ts`). The
    /// server strips `params` — a request shape, not a picker's business.
    public struct CoachModelOption: Codable, Sendable, Equatable {
        public let id: String
        /// Picker option text.
        public let label: String
        /// Short header badge.
        public let badge: String
        /// One line on what you trade away by picking it.
        public let blurb: String
        public let inputPerMTok: Double
        public let outputPerMTok: Double

        public init(id: String, label: String, badge: String, blurb: String, inputPerMTok: Double, outputPerMTok: Double) {
            self.id = id
            self.label = label
            self.badge = badge
            self.blurb = blurb
            self.inputPerMTok = inputPerMTok
            self.outputPerMTok = outputPerMTok
        }

        /// e.g. "$3/$15 per Mtok" — the web's `priceLabel`, shown in the picker
        /// so the saving is visible at the point of choice.
        public var priceLabel: String {
            "$\(trim(inputPerMTok))/$\(trim(outputPerMTok)) per Mtok"
        }

        private func trim(_ value: Double) -> String {
            value == value.rounded() ? String(Int(value)) : String(value)
        }
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
    /// Draft tools only (`update_workout_draft`, `update_chart_draft`): the
    /// reduced draft, or the caller's own draft back when `ok` is false.
    public let draft: JSONValue?

    public init(ok: Bool, resultText: String? = nil, problem: String? = nil, draft: JSONValue? = nil) {
        self.ok = ok
        self.resultText = resultText
        self.problem = problem
        self.draft = draft
    }
}
