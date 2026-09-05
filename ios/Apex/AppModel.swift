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

    private let streams: (any ActivityStreamsReading)?
    private let hub: RealtimeHub?
    private let clock: any ApexClock
    private var mockState: AuthState = .signedOut(reason: nil)
    /// A link that arrived before the stored session was read; replayed once it is.
    private var parkedURL: URL?
    /// A non-auth link (`/app/event/...`) the tabs will consume (W7/W10).
    private(set) var pendingRoute: DeepLink?
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
        let cache = Self.openDatabase()
        let streams = SupabaseActivityStreams(client: auth.supabase)
        let hub = RealtimeHub(client: auth.supabase)
        self.client = client
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
        self.cache = mock.cache
        self.streams = mock.streams
        self.hub = nil
        self.schedule = Self.makeSchedule(client: client, cache: mock.cache, clock: mock.clock, streams: mock.streams, realtime: nil)
    }
    #endif

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
        case .event, .library:
            pendingRoute = link
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
            Task {
                await hub?.resume()
                await schedule.refresh(reason: .foreground)
            }
        case .background:
            Task { await hub?.suspend() }
        default:
            break
        }
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

    /// A cache that will not open is not fatal: the app still works online, and
    /// refusing to launch over it would be worse than losing offline reads.
    private static func openDatabase() -> (any CacheStore)? {
        do {
            return GRDBCacheStore(pool: try ApexDatabase.makePool())
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
