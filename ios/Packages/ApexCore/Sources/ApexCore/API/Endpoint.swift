import Foundation

/// The `/api/*` surface the app reads and writes. Dates are always `YYYY-MM-DD`
/// strings — the API speaks strings, and converting to `Date` here would invent
/// a time zone the server never meant (architecture.md §5).
public struct Endpoint: Sendable, Equatable {
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    public let method: Method
    public let path: String
    public let query: [URLQueryItem]
    public let body: Data?

    public init(method: Method = .get, path: String, query: [URLQueryItem] = [], body: Data? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
    }

    public func url(relativeTo base: URL) -> URL? {
        guard var components = URLComponents(
            url: base.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else { return nil }
        if !query.isEmpty { components.queryItems = query }
        return components.url
    }

    /// Bodies are encoded with sorted keys so the same call always produces
    /// the same bytes — testable, and a stable key for anything that hashes a
    /// request. Slashes stay slashes ("90/90 Hip Stretch"): both spellings are
    /// valid JSON, and the unescaped one is what every test can read.
    static func json<T: Encodable>(_ value: T) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Encoding a value built from Codable structs and JSONValue cannot
        // fail; a crash here would be a programming error, not a runtime one.
        return try! encoder.encode(value) // swiftlint:disable:this force_try
    }

    // MARK: - W0 read endpoints

    /// One window of schedule: bases, expanded occurrences, and whichever
    /// side tables the caller asks for.
    public static func schedule(
        start: String,
        end: String,
        include: [String] = []
    ) -> Endpoint {
        var query = [URLQueryItem(name: "start", value: start), URLQueryItem(name: "end", value: end)]
        if !include.isEmpty {
            query.append(URLQueryItem(name: "include", value: include.joined(separator: ",")))
        }
        return Endpoint(path: "api/schedule", query: query)
    }

    /// The read-only coach tools, callable directly by the app. The handler
    /// (`api/_lib/handlers/query.ts`) is POST-only and reads `{ tool, args }`
    /// from the body; `args` is a JSON object, not a flat string map.
    public static func query(tool: String, args: [String: JSONValue] = [:]) -> Endpoint {
        struct Body: Encodable {
            let tool: String
            let args: [String: JSONValue]
        }
        return Endpoint(method: .post, path: "api/query", body: json(Body(tool: tool, args: args)))
    }

    public static let profile = Endpoint(path: "api/profile")

    /// Records acceptance of the current legal versions. No body: the server
    /// owns which versions are current (`api/_lib/handlers/termsAcceptance.ts`).
    public static let termsAcceptance = Endpoint(method: .post, path: "api/terms-acceptance")

    // MARK: - W2 writes

    /// Toggle an occurrence's completion. The two rows are built by
    /// `CompletionRows.build` — the shape the server's allowlist accepts.
    public static func completions(completionRow: CompletionRow, logRow: CompletionLogRow) -> Endpoint {
        struct Body: Encodable {
            let completionRow: CompletionRow
            let logRow: CompletionLogRow
        }
        return Endpoint(
            method: .post,
            path: "api/completions",
            body: json(Body(completionRow: completionRow, logRow: logRow))
        )
    }

    /// The tracker session actions that need only an occurrence: the plan-filled
    /// `quick-complete` and its undo `quick-uncomplete`. The log-carrying
    /// actions go through `tracker(_:session:)`.
    public static func workoutSessions(action: String, eventId: String, eventDate: String) -> Endpoint {
        struct Body: Encodable {
            let action: String
            let eventId: String
            let eventDate: String
        }
        return Endpoint(
            method: .post,
            path: "api/workout-sessions",
            body: json(Body(action: action, eventId: eventId, eventDate: eventDate))
        )
    }

    // MARK: - W4 tracker

    /// Open the tracker: the server-built model (plan × saved rows × shadows).
    /// Creates the session unless `peek` — the offline prefetch must never stamp
    /// a `started_at` nobody chose. `startedAt` carries a queued offline start
    /// so both paths converge on the same time (ISO; the server bounds it).
    public static func trackerBootstrap(
        eventId: String, eventDate: String, startedAt: String? = nil, peek: Bool = false
    ) -> Endpoint {
        struct Body: Encodable {
            let action = "bootstrap"
            let eventId: String
            let eventDate: String
            let startedAt: String?
            let peek: Bool?
        }
        return sessions(Body(eventId: eventId, eventDate: eventDate, startedAt: startedAt, peek: peek ? true : nil))
    }

    /// One queued tracker op as the request that lands it. Bodies carry only
    /// the fields the handler reads for that action; optionals that are nil are
    /// omitted, which the handler treats as "server decides".
    public static func tracker(_ payload: TrackerOpPayload, session: SessionKey) -> Endpoint {
        switch payload {
        case .start(let startedAt):
            struct Body: Encodable {
                let action = "start"
                let eventId: String
                let eventDate: String
                let startedAt: String?
            }
            return sessions(Body(eventId: session.eventId, eventDate: session.eventDate, startedAt: startedAt))

        case .save(let save):
            struct Body: Encodable {
                let action = "save"
                let eventId: String
                let eventDate: String
                let setLogs: [SetLogRow]
                let cardioLogs: [CardioLogRow]
                let removedSets: [SetKey]
            }
            return sessions(Body(
                eventId: session.eventId, eventDate: session.eventDate,
                setLogs: save.setLogs, cardioLogs: save.cardioLogs, removedSets: save.removedSets
            ))

        case .finish(let finish):
            struct Body: Encodable {
                let action = "finish"
                let eventId: String
                let eventDate: String
                let autofillRows: [SetLogRow]
                let finishedAt: String?
                let score: ScoreSubmission?
            }
            return sessions(Body(
                eventId: session.eventId, eventDate: session.eventDate,
                autofillRows: finish.autofillRows, finishedAt: finish.finishedAt, score: finish.score
            ))

        case .cancel:
            return workoutSessions(action: "cancel", eventId: session.eventId, eventDate: session.eventDate)

        case .swapExercise(let swap):
            struct Body: Encodable {
                let action = "swap-exercise"
                let eventId: String
                let eventDate: String
                let section: String
                let exerciseId: String
                let exerciseName: String
                let definitionId: String?
            }
            return sessions(Body(
                eventId: session.eventId, eventDate: session.eventDate, section: swap.section,
                exerciseId: swap.exerciseId, exerciseName: swap.exerciseName, definitionId: swap.definitionId
            ))

        case .completion(let completionRow, let logRow):
            return completions(completionRow: completionRow, logRow: logRow)
        }
    }

    /// The post-workout coach summary, streamed as NDJSON (`text` · `done` ·
    /// `error`). The server rebuilds the recap from the saved rows and persists
    /// what it streamed; 409 until the session is finished.
    public static func coachSummary(eventId: String, eventDate: String) -> Endpoint {
        struct Body: Encodable {
            let eventId: String
            let eventDate: String
        }
        return Endpoint(method: .post, path: "api/coach-summary", body: json(Body(eventId: eventId, eventDate: eventDate)))
    }

    // MARK: - W6 coach

    /// One coach turn (`POST /api/chat` v2). The server builds the system
    /// prompt from the caller's own data; the body carries only the mode, the
    /// history, the caller's local date and — for the builder/analytics
    /// coaches — the current draft. Labels are stripped from every tool_use
    /// block here: the API rejects unknown fields. `model` is omitted when the
    /// user has no pick so a future default bump moves them with it.
    public static func chat(
        mode: ChatMode, messages: [ApiMessage], withTools: Bool, today: String,
        draft: JSONValue? = nil, model: String? = nil
    ) -> Endpoint {
        struct Context: Encodable { let draft: JSONValue }
        struct Body: Encodable {
            let mode: String
            let messages: [ApiMessage]
            let withTools: Bool
            let today: String
            let context: Context?
            let model: String?
        }
        return Endpoint(method: .post, path: "api/chat", body: json(Body(
            mode: mode.rawValue, messages: messages.map { $0.strippingLabels() }, withTools: withTools,
            today: today, context: draft.map(Context.init), model: model
        )))
    }

    /// Execute a confirmed coach action on the server (`POST /api/coach-tool`,
    /// W5b). `toolUseId` is unused by the handler today and sent for the
    /// planned HMAC check.
    /// `draft` is the builder's / analytics' current draft for the draft
    /// tools, which reduce it and answer with the next one (W7).
    public static func coachTool(toolUseId: String, name: String, input: JSONValue, today: String, draft: JSONValue? = nil) -> Endpoint {
        struct Body: Encodable {
            let toolUseId: String
            let name: String
            let input: JSONValue
            let today: String
            let draft: JSONValue?
        }
        return Endpoint(method: .post, path: "api/coach-tool", body: json(Body(
            toolUseId: toolUseId, name: name, input: input, today: today, draft: draft
        )))
    }

    /// Save, replace or remove (nil) the user's Anthropic key. The server
    /// validates a new key against Anthropic and answers 400 with its message.
    public static func setAnthropicKey(_ key: String?) -> Endpoint {
        let body: [String: JSONValue] = ["anthropic_api_key": key.map(JSONValue.string) ?? .null]
        return Endpoint(method: .patch, path: "api/profile", body: json(body))
    }

    // MARK: - W7 writes
    // Every body carries user attribution: without it the server charges the
    // AI mutation cap (`api/_lib/handlers/events.ts`).

    /// Series-wide field edits (`PATCH /api/events?id=<baseId>`).
    public static func updateEvent(id: String, fields: EventFields, log: EventMutationLog) -> Endpoint {
        struct Body: Encodable {
            let fields: EventFields
            let log: EventMutationLog
        }
        return Endpoint(method: .patch, path: "api/events", query: [URLQueryItem(name: "id", value: id)], body: json(Body(fields: fields, log: log)))
    }

    /// A one-off, or a whole series (`DELETE /api/events?id=<baseId>`).
    public static func deleteEvent(id: String, log: EventMutationLog) -> Endpoint {
        struct Body: Encodable { let log: EventMutationLog }
        return Endpoint(method: .delete, path: "api/events", query: [URLQueryItem(name: "id", value: id)], body: json(Body(log: log)))
    }

    /// Skip one occurrence of a series. `date` is `ScheduleEvent.keyDate`.
    public static func skipInstance(eventId: String, date: String, eventTitle: String) -> Endpoint {
        instance(InstanceBody(eventId: eventId, date: date, eventTitle: eventTitle, overrides: nil))
    }

    /// Move one occurrence of a series (all three override columns are written).
    public static func rescheduleInstance(eventId: String, date: String, eventTitle: String, overrides: OccurrenceOverride) -> Endpoint {
        instance(InstanceBody(eventId: eventId, date: date, eventTitle: eventTitle, overrides: overrides))
    }

    /// The builder's Apply (`POST /api/workout-draft`): the draft JSON in,
    /// the server upserts the template and writes the event.
    public static func workoutDraft(draft: WorkoutDraft, today: String, action: WorkoutDraftAction) -> Endpoint {
        struct Action: Encodable {
            let kind: String
            let eventId: String?
            let occurrenceDate: String?
        }
        struct Body: Encodable {
            let draft: WorkoutDraft
            let today: String
            let action: Action
        }
        let wire: Action = switch action {
        case .create: Action(kind: "create", eventId: nil, occurrenceDate: nil)
        case .update(let eventId): Action(kind: "update", eventId: eventId, occurrenceDate: nil)
        case .detach(let eventId, let occurrenceDate): Action(kind: "detach", eventId: eventId, occurrenceDate: occurrenceDate)
        }
        return Endpoint(method: .post, path: "api/workout-draft", body: json(Body(draft: draft, today: today, action: wire)))
    }

    /// Archive (a timestamp) or restore (nil) a library template.
    public static func archiveTemplate(id: String, archivedAt: String?) -> Endpoint {
        let body: [String: JSONValue] = ["archived_at": archivedAt.map(JSONValue.string) ?? .null]
        return Endpoint(method: .patch, path: "api/workout-templates", query: [URLQueryItem(name: "id", value: id)], body: json(body))
    }

    /// The picker's inline create (`POST /api/exercise-definitions`); the id
    /// is `Slug.name(canonicalName)`, as the web mints it.
    public static func createDefinition(id: String, canonicalName: String, category: String, isUnilateral: Bool) -> Endpoint {
        struct Body: Encodable {
            let id: String
            let canonicalName: String
            let category: String
            let isUnilateral: Bool
            let aliases: [String] = []
            let muscleGroups: [String] = []
            let equipment: [String] = []
            let triggeredBy = "user"
            enum CodingKeys: String, CodingKey {
                case id, category, aliases, equipment
                case canonicalName = "canonical_name"
                case isUnilateral = "is_unilateral"
                case muscleGroups = "muscle_groups"
                case triggeredBy = "triggered_by"
            }
        }
        return Endpoint(method: .post, path: "api/exercise-definitions", body: json(Body(
            id: id, canonicalName: canonicalName, category: category, isUnilateral: isUnilateral
        )))
    }

    private struct InstanceBody: Encodable {
        let eventId: String
        let date: String
        let eventTitle: String
        let overrides: OccurrenceOverride?
        let triggeredBy = "user"
    }

    private static func instance(_ body: InstanceBody) -> Endpoint {
        Endpoint(method: .post, path: "api/event-instances", body: json(body))
    }

    private static func sessions<T: Encodable>(_ body: T) -> Endpoint {
        Endpoint(method: .post, path: "api/workout-sessions", body: json(body))
    }

    // MARK: - W11 profile, integrations, account
    //
    // The profile writes are all PATCH /api/profile against a snake_case
    // allowlist (`api/_lib/handlers/profile.ts`): an unknown key is a 400, so
    // each factory sends exactly the keys its edit owns. Fields that can be
    // CLEARED go through [String: JSONValue] rather than an Encodable struct,
    // because Encodable omits a nil and the server needs an explicit null to
    // tell "leave it alone" from "unset it" — the setAnthropicKey precedent.

    private static func profilePatch(_ fields: [String: JSONValue]) -> Endpoint {
        Endpoint(method: .patch, path: "api/profile", body: json(fields))
    }

    /// 1–80 characters after trimming; the server stores it trimmed.
    public static func setDisplayName(_ name: String) -> Endpoint {
        profilePatch(["display_name": .string(name)])
    }

    /// One of the 24 keys in the server's `AVATAR_KEYS`; anything else is a 400.
    public static func setAvatarKey(_ key: String) -> Endpoint {
        profilePatch(["avatar_key": .string(key)])
    }

    /// Both zones in one write, which is how the section saves. nil clears a
    /// zone (max 100–250, threshold 80–230 when set).
    public static func setHeartRateZones(maxHr: Int?, thresholdHr: Int?) -> Endpoint {
        profilePatch([
            "max_hr": maxHr.map { .number(Double($0)) } ?? .null,
            "threshold_hr": thresholdHr.map { .number(Double($0)) } ?? .null,
        ])
    }

    /// The coach's standing goal and context. `""` is a valid value — clearing
    /// either is an edit, not an omission — so they are sent as given.
    public static func setCoachProfile(goal: String, context: String) -> Endpoint {
        profilePatch(["coach_goal": .string(goal), "coach_context": .string(context)])
    }

    /// Which model the coach runs on. nil clears the pick, putting the user
    /// back on the server's default.
    public static func setCoachModel(_ id: String?) -> Endpoint {
        profilePatch(["coach_model": id.map(JSONValue.string) ?? .null])
    }

    /// A one-way latch — there is no un-dismiss, and only `true` is accepted.
    public static let dismissOnboarding = Endpoint(
        method: .patch, path: "api/profile", body: json(["onboarding_dismissed": JSONValue.bool(true)])
    )

    /// The activity log: the three audit tables merged newest-first, capped at
    /// 100 server-side. No paging and no parameters.
    public static let mutationsLog = Endpoint(path: "api/mutations-log")

    /// Active and revoked personal access tokens, plus the OAuth clients the
    /// user has connected.
    public static let mcpTokens = Endpoint(path: "api/mcp-tokens")

    /// Mint a token. The response carries the plaintext exactly once — show it,
    /// then it is unrecoverable.
    public static func mintMcpToken(name: String) -> Endpoint {
        struct Body: Encodable { let name: String }
        return Endpoint(method: .post, path: "api/mcp-tokens", body: json(Body(name: name)))
    }

    /// Revoke one token. It stays in the list as revoked; nothing is deleted.
    public static func revokeMcpToken(id: String) -> Endpoint {
        Endpoint(method: .delete, path: "api/mcp-tokens", query: [URLQueryItem(name: "id", value: id)])
    }

    /// Disconnect an app: revokes every live token for that client at once.
    /// `client_id` takes precedence over `id` server-side, so it travels alone.
    public static func disconnectApp(clientId: String) -> Endpoint {
        Endpoint(method: .delete, path: "api/mcp-tokens", query: [URLQueryItem(name: "client_id", value: clientId)])
    }

    /// Delete the account and everything that cascades from it (App Store
    /// guideline 5.1.1(v)). The confirmation string is the server's guard
    /// against a stray DELETE — the typed confirmation in the UI is separate.
    public static let deleteAccount = Endpoint(
        method: .delete, path: "api/account", body: json(["confirm": "DELETE"])
    )

    // Provider sync is one POST route with a `body.action` discriminator
    // (`api/_lib/handlers/providerSync.ts`), the workoutSessions shape.

    private static func providerSync<T: Encodable>(_ body: T) -> Endpoint {
        Endpoint(method: .post, path: "api/provider-sync", body: json(body))
    }

    /// Connection state for every provider. The only action that needs no
    /// `provider`, and the only one outside the rate limit.
    public static let providerStatus = Endpoint(
        method: .post, path: "api/provider-sync", body: json(["action": "status"])
    )

    /// Begin the OAuth dance. `client: "ios"` is recorded on the pending row so
    /// the callback redirects to `apextraining://connected` instead of the web
    /// app (phase41) — which is the only thing that closes the
    /// `ASWebAuthenticationSession` the authorize URL is opened in.
    public static func providerConnectStart(provider: String = "coros", client: String? = "ios") -> Endpoint {
        struct Body: Encodable {
            let action = "connect-start"
            let provider: String
            let client: String?
        }
        return providerSync(Body(provider: provider, client: client))
    }

    /// Drop the connection row. The imported activities and their streams stay.
    public static func providerDisconnect(provider: String = "coros") -> Endpoint {
        struct Body: Encodable {
            let action = "disconnect"
            let provider: String
        }
        return providerSync(Body(provider: provider))
    }

    /// The nightly-sync opt-out.
    public static func providerAutoSync(enabled: Bool, provider: String = "coros") -> Endpoint {
        struct Body: Encodable {
            let action = "set-auto-sync"
            let provider: String
            let enabled: Bool
        }
        return providerSync(Body(provider: provider, enabled: enabled))
    }

    /// What a sync would do. Writes nothing. `timezone` is a required IANA
    /// zone — it is what places each activity on a calendar date.
    public static func providerPreview(timezone: String, provider: String = "coros") -> Endpoint {
        struct Body: Encodable {
            let action = "preview"
            let provider: String
            let timezone: String
        }
        return providerSync(Body(provider: provider, timezone: timezone))
    }

    /// Execute the settled decisions — one call for the whole queue, never one
    /// per card. 1–100 decisions, each activity at most once.
    public static func providerApply(timezone: String, decisions: [SyncDecision], provider: String = "coros") -> Endpoint {
        struct Body: Encodable {
            let action = "apply"
            let provider: String
            let timezone: String
            let decisions: [SyncDecision]
        }
        return providerSync(Body(provider: provider, timezone: timezone, decisions: decisions))
    }
}
