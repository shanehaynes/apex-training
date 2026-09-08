import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import ApexCore

/// `ios/Fixtures/` sits outside the package (see FixtureContractTests).
enum TestFixtures {
    static let directory: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ApexCoreTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // ApexCore
        .deletingLastPathComponent()  // Packages
        .deletingLastPathComponent()  // ios
        .appendingPathComponent("Fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name))
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: try data(name))
    }

    static func bootstrap() throws -> TrackerBootstrap { try decode(TrackerBootstrap.self, "bootstrap.json") }
}

/// Suspends callers until opened — for "while a request is in flight" tests.
actor Gate {
    private(set) var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        for w in waiters { w.resume() }
        waiters = []
    }
}

struct RecordedRequest: @unchecked Sendable {
    let method: String
    let path: String
    let body: [String: Any]?
    let bodyText: String

    var action: String? { body?["action"] as? String }
}

/// Scripted `HTTPTransport`: a queue of responses (the last one repeats), a
/// request log, an optional gate that holds the next request in flight, and
/// thrown errors for the network-down path.
actor ScriptedTransport: HTTPTransport {
    enum Step: Sendable {
        case respond(HTTPResponse)
        case throwNetwork
        /// A chunked 2xx body. Each chunk is delivered as its own `Data`; when
        /// `holdOpen` is set the stream stays open after the last chunk until
        /// the gate opens (or the consumer cancels) — the "Stop mid-stream" seam.
        case stream(status: Int, headers: [String: String], chunks: [String], holdOpen: Gate?)

        static func ok(_ json: String = #"{"ok":true}"#) -> Step { .respond(HTTPResponse(status: 200, body: Data(json.utf8))) }
        static func status(_ code: Int, body: String = "", headers: [String: String] = [:]) -> Step {
            .respond(HTTPResponse(status: code, headers: headers, body: Data(body.utf8)))
        }
        /// One NDJSON line per chunk.
        static func ndjson(_ lines: [String], holdOpen: Gate? = nil) -> Step {
            .stream(status: 200, headers: ["Content-Type": "application/x-ndjson"],
                    chunks: lines.map { $0 + "\n" }, holdOpen: holdOpen)
        }
        /// Arbitrary byte splits of one NDJSON body.
        static func chunks(_ chunks: [String]) -> Step {
            .stream(status: 200, headers: ["Content-Type": "application/x-ndjson"], chunks: chunks, holdOpen: nil)
        }
    }

    private var steps: [Step]
    private(set) var requests: [RecordedRequest] = []
    /// Streams whose consumer went away before the body finished.
    private(set) var streamCancellations = 0
    private var holdNext: Gate?
    private var holdOnce = false

    init(_ steps: [Step] = [.respond(HTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8)))]) {
        self.steps = steps
    }

    func script(_ steps: [Step]) { self.steps = steps }

    /// The next request suspends until the gate opens.
    func hold(with gate: Gate) {
        holdNext = gate
        holdOnce = true
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        switch try await next(request) {
        case .respond(let response): return response
        case .throwNetwork: throw URLError(.notConnectedToInternet)
        case .stream(let status, let headers, let chunks, _):
            return HTTPResponse(status: status, headers: headers, body: Data(chunks.joined().utf8))
        }
    }

    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        switch try await next(request) {
        case .respond(let response): return HTTPStreamResponse(response)
        case .throwNetwork: throw URLError(.notConnectedToInternet)
        case .stream(let status, let headers, let chunks, let holdOpen):
            let (bytes, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            let producer = Task {
                for chunk in chunks {
                    continuation.yield(Data(chunk.utf8))
                    await Task.yield()
                }
                if let holdOpen {
                    while !Task.isCancelled, await !holdOpen.isOpen {
                        try? await Task.sleep(nanoseconds: 2_000_000)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { termination in
                producer.cancel()
                if case .cancelled = termination { Task { await self.noteCancellation() } }
            }
            return HTTPStreamResponse(status: status, headers: headers, bytes: bytes)
        }
    }

    private func noteCancellation() { streamCancellations += 1 }

    private func next(_ request: URLRequest) async throws -> Step {
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        requests.append(RecordedRequest(
            method: request.httpMethod ?? "", path: request.url?.path ?? "",
            body: body, bodyText: request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
        ))
        if holdOnce, let gate = holdNext {
            holdOnce = false
            holdNext = nil
            await gate.wait()
        }
        return steps.count > 1 ? steps.removeFirst() : (steps.first ?? Step.ok())
    }

    var count: Int { requests.count }
    func requests(action: String) -> [RecordedRequest] { requests.filter { $0.action == action } }
}

actor StaticTokens: TokenProvider {
    private(set) var refreshes = 0
    private(set) var signOuts = 0
    func accessToken() async throws -> String { "t" }
    func refresh() async throws -> String { refreshes += 1; return "t" }
    func signOut() async { signOuts += 1 }
}

/// Collects a queue's events so a test can assert on them after the fact.
actor EventRecorder {
    private(set) var events: [QueueEvent] = []
    private var task: Task<Void, Never>?

    func start(_ stream: AsyncStream<QueueEvent>) {
        task = Task { for await event in stream { await self.append(event) } }
    }

    private func append(_ event: QueueEvent) { events.append(event) }

    /// Polls briefly — emission is synchronous but the consuming task is not.
    func waitFor(_ predicate: @Sendable ([QueueEvent]) -> Bool, timeout: Double = 2) async -> [QueueEvent] {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate(events), Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return events
    }

    func stop() { task?.cancel() }
}

func makeClient(_ transport: ScriptedTransport, tokens: StaticTokens = StaticTokens()) -> ApexClient {
    ApexClient(baseURL: URL(string: "http://127.0.0.1:5314")!, transport: transport, tokens: tokens)
}

let fixtureSession = SessionKey(eventId: "ios-fixture-weekly__2026-09-22", eventDate: "2026-09-22")

func setRow(_ setNumber: Int, weight: String? = "100", reps: String? = "5", exerciseId: String = "fx-press") -> SetLogRow {
    SetLogRow(
        eventId: fixtureSession.eventId, eventDate: fixtureSession.eventDate, section: "exercise",
        exerciseId: exerciseId, exerciseName: "Fixture Press", definitionId: "ios-fixture-def", setNumber: setNumber,
        plannedWeight: "100 lb", plannedReps: "5", actualWeight: weight, actualReps: reps
    )
}
