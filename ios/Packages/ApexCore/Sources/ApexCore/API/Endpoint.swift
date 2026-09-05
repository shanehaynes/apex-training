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
    /// request.
    static func json<T: Encodable>(_ value: T) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
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

    private static func sessions<T: Encodable>(_ body: T) -> Endpoint {
        Endpoint(method: .post, path: "api/workout-sessions", body: json(body))
    }
}
