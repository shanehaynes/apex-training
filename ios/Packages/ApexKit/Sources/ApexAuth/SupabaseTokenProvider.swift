import ApexCore
import Foundation
import Supabase

/// Bridges supabase-swift to `ApexCore.TokenProvider`.
///
/// Thin on purpose: the 401 → refresh → retry → sign-out *policy* lives in
/// `ApexClient` so it can be proved on Linux. This only knows how to fetch,
/// renew and discard a token.
public struct SupabaseTokenProvider: TokenProvider {
    private let auth: AuthClient
    private let onSignOut: @Sendable () async -> Void

    public init(auth: AuthClient, onSignOut: @escaping @Sendable () async -> Void) {
        self.auth = auth
        self.onSignOut = onSignOut
    }

    public func accessToken() async throws -> String {
        try await auth.session.accessToken
    }

    public func refresh() async throws -> String {
        try await auth.refreshSession().accessToken
    }

    public func signOut() async {
        try? await auth.signOut()
        await onSignOut()
    }
}
