import ApexActivity
import ApexAuth
import ApexCore
import ApexFeatures
import ApexPersistence
import ApexUI
import Foundation
import GRDB
import Observation
import SwiftUI

/// Everything a screen reaches for, assembled once and put in the environment.
///
/// Two ways to build one: `init(auth:)` is the app; `init(mock:)` (DEBUG only)
/// is the fixture-fed instance the XCUITest smoke launches with
/// `-apexMockClient` — CI's unsigned build has no Keychain, so a real sign-in
/// can never persist there (ios/CLAUDE.md), and the screens still need proving.
@MainActor
@Observable
final class AppModel {
    let auth: AuthService?
    private(set) var client: ApexClient?
    private(set) var cache: (any CacheStore)?
    private(set) var schedule: ScheduleModel
    /// The tracker's write queue and friends, built per signed-in user: the
    /// `tracker_ops` store is per owner so unsynced work never flushes under
    /// another account (architecture.md §7). Nil until `ensureQueue`.
    private(set) var trackerServices: TrackerServices?
    /// The Coach tab's model, built per signed-in user over a per-owner
    /// conversation store (D-025). Nil until `ensureQueue`.
    private(set) var coach: CoachModel?

    private let pool: DatabasePool?
    private var queueOwner: String?
    private var queueDriver: WriteQueueDriver?
    private let streams: (any ActivityStreamsReading)?
    private let hub: RealtimeHub?
    private let clock: any ApexClock
    private var mockState: AuthState = .signedOut(reason: nil)
    /// A link that arrived before the stored session was read; replayed once it is.
    private var parkedURL: URL?
    /// Non-auth links (`/app/...`) and the tab selection: the tabs consume from
    /// here (W12 `.tracker`; W7/W10 `.event`/`.library`).
    let routes = RouteBus()
    /// The Live Activity (W12), per signed-in user like the queue. Nil until
    /// `ensureQueue`; the mock runs on the real one too, so the simulator can
    /// prove the island without a backend — except under the XCUITest smoke.
    private var activity: LiveActivityController?
    /// Whether the set-password screen must also collect acceptance: the terms
    /// gate 403s every other read for an invitee who never accepted on the web.
    private(set) var needsTermsAcceptance = false

    init(auth: AuthService) {
        self.auth = auth
        self.clock = SystemClock()
        auth.start()
        let tokens = SupabaseTokenProvider(auth: auth.auth) { [weak auth] in
            await MainActor.run { auth?.expire(reason: "Session expired. Sign in again.") }
        }
        let client = ApexClient(baseURL: AppConfig.apiBase, transport: URLSessionTransport(), tokens: tokens)
        let pool = Self.openDatabase()
        let cache: (any CacheStore)? = pool.map { GRDBCacheStore(pool: $0) }
        let streams = SupabaseActivityStreams(client: auth.supabase)
        let hub = RealtimeHub(client: auth.supabase)
        self.client = client
        self.pool = pool
        self.cache = cache
        self.streams = streams
        self.hub = hub
        self.schedule = Self.makeSchedule(client: client, cache: cache, clock: SystemClock(), streams: streams, realtime: hub)
    }

    #if DEBUG
    init(mock: MockEnvironment) {
        self.auth = nil
        self.clock = mock.clock
        let client = ApexClient(baseURL: AppConfig.apiBase, transport: mock.transport, tokens: mock.tokens)
        self.client = client
        self.pool = nil
        self.cache = mock.cache
        self.streams = mock.streams
        self.hub = nil
        self.schedule = Self.makeSchedule(client: client, cache: mock.cache, clock: mock.clock, streams: mock.streams, realtime: nil)
    }
    #endif

    /// Called once the root knows who is signed in. Idempotent per owner. The
    /// queue outlives nothing: a new owner gets a new queue over their own rows.
    func ensureQueue(owner: String) {
        guard queueOwner != owner, let client else { return }
        queueOwner = owner
        let store: any WriteQueueStore = pool.map { GRDBWriteQueueStore(pool: $0, owner: owner) } ?? MemoryWriteQueueStore()
        // Backoff runs on real time even under the mock: its TestClock would make
        // every retry instant, and the smoke wants to see the pending chip.
        let queue = WriteQueue(store: store, client: client, clock: SystemClock())
        let cache = cache ?? MemoryCacheStore()
        let publisher: any TrackerActivityPublishing
        if CommandLine.arguments.contains("-apexUITest") {
            publisher = NoActivityPublisher()
        } else {
            let controller = LiveActivityController()
            activity = controller
            publisher = controller
            // Whatever the system kept alive across a kill: keep it if the
            // session is still open, end it otherwise (architecture.md §12).
            Task { await controller.adoptExisting { key in await Self.isSessionOpen(key, in: cache) } }
        }
        trackerServices = TrackerServices(client: client, cache: cache, queue: queue, clock: clock, activity: publisher)
        queueDriver?.stop()
        queueDriver = WriteQueueDriver(queue: queue)
        Task { await queue.flush() }

        coach?.shutdown()
        let conversations: any ConversationStore = pool.map { GRDBConversationStore(pool: $0, owner: owner) } ?? MemoryConversationStore()
        coach = CoachModel(services: CoachServices(
            client: client, store: conversations, clock: clock,
            onMutationConfirmed: { [weak self] in
                // Realtime covers the events table; the completion a retro-log
                // writes is not subscribed (architecture.md §8), so refresh.
                Task { await self?.schedule.refresh(reason: .coachMutation) }
            }
        ))
    }

    var state: AuthState { auth?.state ?? mockState }

    func signIn(email: String, password: String) async -> String? {
        guard let auth else {
            mockState = .signedIn(userID: "ios-fixture-user", email: email)
            return nil
        }
        do {
            try await auth.signIn(email: email, password: password)
            return nil
        } catch {
            return Self.readable(error)
        }
    }

    func sendPasswordReset(email: String) async -> String? {
        guard !email.isEmpty else { return "Enter your email first." }
        guard let auth else { return nil }
        do {
            try await auth.sendPasswordReset(email: email)
            return nil
        } catch {
            return Self.readable(error)
        }
    }

    // MARK: - Links

    /// `.onOpenURL`: universal links and `apextraining://` both land here.
    func open(_ url: URL) async {
        guard let link = DeepLink.parse(url) else { return }
        if case .restoring = state {
            parkedURL = url
            return
        }
        switch link {
        case .authCode, .authTokens, .authError:
            let outcome: AuthLinkOutcome
            if let auth {
                outcome = await auth.handle(link, originalURL: url)
            } else {
                #if DEBUG
                outcome = openInMock(link)
                #else
                return
                #endif
            }
            switch outcome {
            case .signedIn:
                break
            case .needsPassword:
                // The mock decides this itself; asking its profile fixture
                // (terms current) would flip it back mid-render.
                if auth != nil { await loadTermsNeed() }
            case .failed(let message):
                // A spent link is a reason, not a sign-out: whoever is signed in
                // stays signed in, and the sign-in card gets the explanation.
                ToastBus.shared.post(message, level: .failure)
            }
        case .event, .library, .tracker:
            routes.open(link)
        case .connected(let provider):
            ToastBus.shared.post("\(provider.capitalized) connected.", level: .success)
        case .connectError(_, let message):
            ToastBus.shared.post(message ?? "The connection was not completed.", level: .failure)
        }
    }

    /// Called by the root once `state` leaves `.restoring`.
    func replayParkedLink() {
        guard let url = parkedURL else { return }
        parkedURL = nil
        Task { await open(url) }
    }

    func setPassword(_ password: String, acceptTerms: Bool) async -> String? {
        guard let auth else {
            mockState = .signedIn(userID: "ios-fixture-user", email: "agent@apex.local")
            return nil
        }
        do {
            try await auth.setPassword(password)
        } catch {
            return Self.readable(error)
        }
        // After the password lands, not before (SetPasswordView.tsx): the
        // ledger stays free of rows for abandoned set-ups. Non-fatal — the
        // gate asks again on the next load.
        if acceptTerms, let client {
            _ = try? await client.data(for: .termsAcceptance)
        }
        needsTermsAcceptance = false
        return nil
    }

    func cancelPasswordSetup() {
        signOut()
    }

    /// GET /api/profile is exempt from the terms gate precisely so it can answer this.
    private func loadTermsNeed() async {
        guard let client, let data = try? await client.data(for: .profile),
              let profile = try? JSONDecoder().decode(ProfileResponse.self, from: data) else { return }
        needsTermsAcceptance = !profile.termsCurrent
    }

    #if DEBUG
    /// The mock has no GoTrue: an invite/recovery fragment lands on set-password,
    /// anything else with tokens signs in, an error fragment shows the reason.
    private func openInMock(_ link: DeepLink) -> AuthLinkOutcome {
        switch link {
        case .authTokens(_, _, let type) where type?.needsPassword == true:
            mockState = .needsPassword(userID: "ios-fixture-user", email: "agent@apex.local")
            needsTermsAcceptance = true
            return .needsPassword
        case .authTokens, .authCode:
            mockState = .signedIn(userID: "ios-fixture-user", email: "agent@apex.local")
            return .signedIn
        case .authError(let error):
            return .failed(error.message)
        default:
            return .failed("Not a sign-in link.")
        }
    }
    #endif

    func signOut() {
        schedule.stop()
        // The queue's rows stay (per owner); the instance goes with the session.
        queueDriver?.stop()
        queueDriver = nil
        trackerServices = nil
        // Nothing in the island belongs to the next account.
        if let activity { Task { await activity.endAll() } }
        coach?.shutdown()
        coach = nil
        queueOwner = nil
        Task {
            await hub?.reset()
            // Another account may sign in next; nothing cached belongs to it.
            for kind in CacheKind.allCases { try? await cache?.purge(kind: kind) }
            if let auth { await auth.signOut() } else { mockState = .signedOut(reason: nil) }
        }
        schedule = Self.makeSchedule(client: client!, cache: cache, clock: clock, streams: streams, realtime: hub)
    }

    /// Realtime lives only while the scene is active (architecture.md §8); the
    /// foreground refresh covers whatever happened in between.
    func scenePhase(_ phase: ScenePhase) {
        guard case .signedIn = state else { return }
        switch phase {
        case .active:
            queueDriver?.sceneBecameActive()
            Task {
                await hub?.resume()
                await schedule.refresh(reason: .foreground)
            }
        case .background:
            // The write queue's visibilitychange analog (architecture.md §7).
            queueDriver?.sceneEnteredBackground()
            Task { await hub?.suspend() }
        default:
            break
        }
    }

    /// The cached bootstrap is the only record of a session an app kill left
    /// behind: started and not finished means the island should keep counting.
    /// No cache entry means a cancel purged it — or it was never ours.
    private static func isSessionOpen(_ key: SessionKey, in cache: any CacheStore) async -> Bool {
        guard let entry = try? await cache.read(
                kind: .trackerBootstrap, key: ScheduleCacheKey.trackerBootstrap(eventId: key.eventId, eventDate: key.eventDate)
              ),
              let bootstrap = try? JSONDecoder().decode(TrackerBootstrap.self, from: entry.json),
              let session = bootstrap.session else { return false }
        return session.startedAt != nil && session.finishedAt == nil
    }

    private static func makeSchedule(
        client: ApexClient, cache: (any CacheStore)?, clock: any ApexClock,
        streams: (any ActivityStreamsReading)?, realtime: (any RealtimeChanges)?
    ) -> ScheduleModel {
        ScheduleModel(deps: ScheduleDependencies(
            client: client,
            cache: cache ?? MemoryCacheStore(),
            clock: clock,
            streams: streams,
            realtime: realtime
        ))
    }

    /// A database that will not open is not fatal: the app still works online
    /// (the cache and the write queue fall back to memory), and refusing to
    /// launch over it would be worse than losing offline reads.
    private static func openDatabase() -> DatabasePool? {
        do {
            return try ApexDatabase.makePool()
        } catch {
            ToastBus.shared.post("Offline cache unavailable.", level: .failure)
            return nil
        }
    }

    private static func readable(_ error: Error) -> String {
        if let apiError = error as? APIError { return apiError.description }
        let message = error.localizedDescription
        // supabase-swift surfaces bad credentials as a 400 with this body.
        if message.lowercased().contains("invalid login credentials") {
            return "That email and password do not match."
        }
        return message
    }
}
