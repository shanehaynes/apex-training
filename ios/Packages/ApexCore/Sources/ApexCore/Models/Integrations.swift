import Foundation

// The You tab's non-profile surfaces (W11): the activity log, the AI connector's
// tokens and connected apps, the COROS connection and its two-phase sync, and
// account deletion.
//
// Casing is split the way Tracker.swift's is, and for the same reason: the MCP
// token rows and the activity log are raw DB rows served as they are read
// (snake_case), while everything the server composes — the connection status
// projection, the sync proposals, the apply outcome — is camelCase. One global
// key strategy could not serve both, so the snake_case shapes spell out
// `CodingKeys` and the rest declare none.

// MARK: - Activity log

/// One row of `GET /api/mutations-log` — the merged, newest-first feed of the
/// three audit tables, capped at 100 server-side.
public struct ActivityLogEntry: Codable, Sendable, Equatable {
    /// Which table it came from. A plain `String` rather than an enum so a
    /// source added server-side never fails the whole decode.
    public let source: String
    /// `create`, `update`, `delete`, `delete_instance`, `update_instance`,
    /// `archive`, `unarchive` — again open, for the same reason.
    public let operation: String
    /// Event title, definition name or block/objective name, per `source`.
    public let title: String
    /// Events only; nil for every other source.
    public let eventDate: String?
    /// `"user"` earns the You badge; anything else (in practice `"ai"`) the
    /// Coach badge — the web compares `=== 'user'` and so does this.
    public let triggeredBy: String
    public let loggedAt: String

    public init(source: String, operation: String, title: String, eventDate: String?, triggeredBy: String, loggedAt: String) {
        self.source = source
        self.operation = operation
        self.title = title
        self.eventDate = eventDate
        self.triggeredBy = triggeredBy
        self.loggedAt = loggedAt
    }

    enum CodingKeys: String, CodingKey {
        case source, operation, title
        case eventDate = "event_date"
        case triggeredBy = "triggered_by"
        case loggedAt = "logged_at"
    }

    /// Whether the user made this change themselves.
    public var isUserTriggered: Bool { triggeredBy == "user" }
}

/// `GET /api/mutations-log`.
public struct ActivityLogResponse: Codable, Sendable, Equatable {
    public let entries: [ActivityLogEntry]

    public init(entries: [ActivityLogEntry]) { self.entries = entries }
}

// MARK: - AI connector

/// One personal access token as `GET /api/mcp-tokens` lists it. Revoked tokens
/// are listed too — `revokedAt != nil` is how the UI filters them out, matching
/// the web, which never deletes a token row.
public struct McpToken: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    /// The displayed tail. The plaintext token exists in exactly one response,
    /// the mint below, and is never stored server-side.
    public let tokenLast4: String
    public let createdAt: String
    public let lastUsedAt: String?
    public let revokedAt: String?

    public init(id: String, name: String, tokenLast4: String, createdAt: String, lastUsedAt: String?, revokedAt: String?) {
        self.id = id
        self.name = name
        self.tokenLast4 = tokenLast4
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.revokedAt = revokedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, name
        case tokenLast4 = "token_last4"
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
        case revokedAt = "revoked_at"
    }

    public var isActive: Bool { revokedAt == nil }
}

/// An OAuth client the user has granted access — one row per `client_id`,
/// deduped server-side from the live refresh grants.
public struct McpConnection: Codable, Sendable, Equatable, Identifiable {
    public let clientId: String
    public let name: String
    public let createdAt: String

    public init(clientId: String, name: String, createdAt: String) {
        self.clientId = clientId
        self.name = name
        self.createdAt = createdAt
    }

    public var id: String { clientId }

    enum CodingKeys: String, CodingKey {
        case clientId = "client_id"
        case name
        case createdAt = "created_at"
    }
}

/// `GET /api/mcp-tokens`.
public struct McpTokensResponse: Codable, Sendable, Equatable {
    public let tokens: [McpToken]
    public let connections: [McpConnection]

    public init(tokens: [McpToken], connections: [McpConnection]) {
        self.tokens = tokens
        self.connections = connections
    }

    /// What the token list renders; the server returns revoked rows too.
    public var activeTokens: [McpToken] { tokens.filter(\.isActive) }
}

/// `POST /api/mcp-tokens` — the only response that ever carries the plaintext
/// token. It cannot be fetched again, which is what the one-time reveal is for.
public struct MintedMcpToken: Codable, Sendable, Equatable {
    public let id: String
    public let token: String

    public init(id: String, token: String) {
        self.id = id
        self.token = token
    }
}

/// `DELETE /api/mcp-tokens` — revoking a token, or disconnecting an app.
/// `revoked` is the token count and is present only on the disconnect form.
public struct McpRevokeResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let revoked: Int?

    public init(ok: Bool, revoked: Int? = nil) {
        self.ok = ok
        self.revoked = revoked
    }
}

// MARK: - COROS

/// The only projection of a provider connection a client ever sees — no token
/// material reaches it.
public struct ProviderConnection: Codable, Sendable, Equatable {
    /// `disconnected` · `pending` · `connected` · `expired`. Open for the usual
    /// reason; `ProviderConnection.Status` below is the convenience reading.
    public let status: String
    public let lastSyncedAt: String?
    public let connectedAt: String?
    /// Whether the nightly cron may sync this connection.
    public let autoSync: Bool
    /// Matches awaiting a fill decision — the Sync button's badge.
    public let pendingFillCount: Int
    /// False when the deployment has no COROS credentials at all, in which case
    /// the whole section is hidden rather than shown as disconnected.
    public let configured: Bool

    public init(
        status: String, lastSyncedAt: String?, connectedAt: String?,
        autoSync: Bool, pendingFillCount: Int, configured: Bool
    ) {
        self.status = status
        self.lastSyncedAt = lastSyncedAt
        self.connectedAt = connectedAt
        self.autoSync = autoSync
        self.pendingFillCount = pendingFillCount
        self.configured = configured
    }

    public enum Status: String, Sendable, Equatable {
        case disconnected, pending, connected, expired
    }

    /// nil for a status this build does not know.
    public var known: Status? { Status(rawValue: status) }
}

/// `POST /api/provider-sync { action: "status" }`.
public struct ProviderStatusResponse: Codable, Sendable, Equatable {
    public let coros: ProviderConnection

    public init(coros: ProviderConnection) { self.coros = coros }
}

/// `POST /api/provider-sync { action: "connect-start" }`. The URL is opened in
/// an `ASWebAuthenticationSession`, which closes on the callback's redirect to
/// `apextraining://connected` or `apextraining://connect_error` — see
/// `DeepLink`, and the `client: "ios"` the endpoint sends to arrange it.
public struct ConnectStartResponse: Codable, Sendable, Equatable {
    public let authorizeUrl: String

    public init(authorizeUrl: String) { self.authorizeUrl = authorizeUrl }
}

/// `POST /api/provider-sync { action: "set-auto-sync" }`.
public struct AutoSyncResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let autoSync: Bool

    public init(ok: Bool, autoSync: Bool) {
        self.ok = ok
        self.autoSync = autoSync
    }
}

/// One activity the watch has that the app does not, and the planned workout it
/// looks like, if any. Preview writes nothing — a proposal is a question.
public struct SyncProposal: Codable, Sendable, Equatable {
    public let activity: SyncActivity
    /// nil means nothing was planned for it, which imports without asking.
    public let match: SyncMatch?

    public init(activity: SyncActivity, match: SyncMatch?) {
        self.activity = activity
        self.match = match
    }

    /// Only a matched proposal needs the "Keep separate" / "Fill it" question.
    public var needsConfirmation: Bool { match != nil }
}

public struct SyncActivity: Codable, Sendable, Equatable, Identifiable {
    public let activityId: String
    public let sportLabel: String
    /// The Apex workout type the sport maps to.
    public let apexType: String
    /// Placed in the user's own time zone, which the request supplies.
    public let localDate: String
    /// Pre-formatted, e.g. "6:32 AM".
    public let displayTime: String
    public let durationMin: Int
    /// Pre-formatted with units, e.g. "5.21 mi" — never a bare number.
    public let distance: String?
    public let avgHr: Int?

    public init(
        activityId: String, sportLabel: String, apexType: String, localDate: String,
        displayTime: String, durationMin: Int, distance: String?, avgHr: Int?
    ) {
        self.activityId = activityId
        self.sportLabel = sportLabel
        self.apexType = apexType
        self.localDate = localDate
        self.displayTime = displayTime
        self.durationMin = durationMin
        self.distance = distance
        self.avgHr = avgHr
    }

    public var id: String { activityId }
}

public struct SyncMatch: Codable, Sendable, Equatable {
    public let eventId: String
    public let eventDate: String
    public let title: String
    public let startTime: String?
    public let type: String

    public init(eventId: String, eventDate: String, title: String, startTime: String?, type: String) {
        self.eventId = eventId
        self.eventDate = eventDate
        self.title = title
        self.startTime = startTime
        self.type = type
    }
}

/// `POST /api/provider-sync { action: "preview" }`.
public struct SyncPreviewResponse: Codable, Sendable, Equatable {
    public let proposals: [SyncProposal]

    public init(proposals: [SyncProposal]) { self.proposals = proposals }
}

/// One settled decision from the confirmation queue. Nothing is written until
/// the queue empties and every decision goes up in a single apply.
public struct SyncDecision: Encodable, Sendable, Equatable {
    public let activityId: String
    /// `fill` writes the activity into the matched event; `create` imports it
    /// as a workout of its own.
    public let action: String
    public let targetEventId: String?
    public let eventDate: String?

    private init(activityId: String, action: String, targetEventId: String?, eventDate: String?) {
        self.activityId = activityId
        self.action = action
        self.targetEventId = targetEventId
        self.eventDate = eventDate
    }

    /// "Fill it" — the server rejects a fill without both target fields.
    public static func fill(activityId: String, targetEventId: String, eventDate: String) -> SyncDecision {
        SyncDecision(activityId: activityId, action: "fill", targetEventId: targetEventId, eventDate: eventDate)
    }

    /// "Keep separate", and the automatic choice for an unmatched activity.
    public static func create(activityId: String) -> SyncDecision {
        SyncDecision(activityId: activityId, action: "create", targetEventId: nil, eventDate: nil)
    }
}

/// `POST /api/provider-sync { action: "apply" }`. Partial success is normal:
/// a failed decision lands in `errors` while the rest still apply.
public struct SyncApplyOutcome: Codable, Sendable, Equatable {
    public let created: Int
    public let filled: Int
    public let errors: [SyncApplyError]

    public init(created: Int, filled: Int, errors: [SyncApplyError]) {
        self.created = created
        self.filled = filled
        self.errors = errors
    }

    public struct SyncApplyError: Codable, Sendable, Equatable {
        public let activityId: String
        /// `activity-not-available` · `fill-target-unavailable` · `write-failed`.
        public let error: String

        public init(activityId: String, error: String) {
            self.activityId = activityId
            self.error = error
        }
    }
}

// MARK: - Account

/// `DELETE /api/account` (PR #93). Irreversible: the auth user goes and every
/// `user_id` row cascades with it.
public struct AccountDeleteResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let deleted: String

    public init(ok: Bool, deleted: String) {
        self.ok = ok
        self.deleted = deleted
    }
}

/// `PATCH /api/profile`. The key fields are optional because the handler drops
/// them when the write succeeded but the status read-back did not — it will not
/// fail a good write over a cosmetic detail.
public struct ProfileUpdateResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let hasAnthropicKey: Bool?
    public let anthropicKeyLast4: String?

    public init(ok: Bool, hasAnthropicKey: Bool? = nil, anthropicKeyLast4: String? = nil) {
        self.ok = ok
        self.hasAnthropicKey = hasAnthropicKey
        self.anthropicKeyLast4 = anthropicKeyLast4
    }
}
