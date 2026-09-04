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
