import ApexAuth
import ApexCore
import ApexPersistence
import ApexUI
import Foundation
import GRDB
import Observation

/// Everything a screen reaches for, assembled once and put in the environment.
@MainActor
@Observable
final class AppModel {
    let auth: AuthService
    private(set) var client: ApexClient?
    private(set) var cache: (any CacheStore)?

    init(auth: AuthService) {
        self.auth = auth
        auth.start()
        buildClient()
        openDatabase()
    }

    var state: AuthState { auth.state }

    func signIn(email: String, password: String) async -> String? {
        do {
            try await auth.signIn(email: email, password: password)
            return nil
        } catch {
            return Self.readable(error)
        }
    }

    func sendPasswordReset(email: String) async -> String? {
        guard !email.isEmpty else { return "Enter your email first." }
        do {
            try await auth.sendPasswordReset(email: email)
            return nil
        } catch {
            return Self.readable(error)
        }
    }

    func signOut() {
        Task { await auth.signOut() }
    }

    private func buildClient() {
        let tokens = SupabaseTokenProvider(auth: auth.auth) { [weak self] in
            await MainActor.run { self?.auth.expire(reason: "Session expired. Sign in again.") }
        }
        client = ApexClient(
            baseURL: AppConfig.apiBase,
            transport: URLSessionTransport(),
            tokens: tokens
        )
    }

    /// A cache that will not open is not fatal: the app still works online, and
    /// refusing to launch over it would be worse than losing offline reads.
    private func openDatabase() {
        do {
            cache = GRDBCacheStore(pool: try ApexDatabase.makePool())
        } catch {
            ToastBus.shared.post("Offline cache unavailable.", level: .failure)
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
