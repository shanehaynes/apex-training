import ApexCore
import Foundation
import Supabase

public enum AuthState: Equatable, Sendable {
    /// Before the stored session has been read. The root shows a splash, not the
    /// sign-in screen — flashing sign-in at a signed-in user is the bug this
    /// case exists to prevent.
    case restoring
    case signedOut(reason: String?)
    case signedIn(userID: String, email: String?)
}

/// supabase-swift's Auth, wrapped so the rest of the app never imports the SDK.
@MainActor
@Observable
public final class AuthService {
    public private(set) var state: AuthState = .restoring

    private let client: SupabaseClient
    private var watcher: Task<Void, Never>?

    public init(supabaseURL: URL, anonKey: String) {
        // Keychain storage is the SDK default on Apple platforms; PKCE is
        // required for the invite and recovery links to complete in-app.
        self.client = SupabaseClient(
            supabaseURL: supabaseURL,
            supabaseKey: anonKey,
            options: .init(auth: .init(flowType: .pkce))
        )
    }

    public var auth: AuthClient { client.auth }
    public var supabase: SupabaseClient { client }

    /// Reads whatever session the Keychain already holds, then keeps `state` in
    /// step with the SDK for the life of the process.
    public func start() {
        guard watcher == nil else { return }
        watcher = Task { [weak self] in
            guard let self else { return }
            for await (event, session) in client.auth.authStateChanges {
                switch event {
                case .initialSession, .signedIn, .tokenRefreshed, .userUpdated:
                    if let session {
                        state = .signedIn(
                            userID: session.user.id.uuidString,
                            email: session.user.email
                        )
                    } else {
                        state = .signedOut(reason: nil)
                    }
                case .signedOut:
                    state = .signedOut(reason: nil)
                default:
                    continue
                }
            }
        }
    }

    public func signIn(email: String, password: String) async throws {
        _ = try await client.auth.signIn(email: email, password: password)
    }

    /// Clears the Keychain as well as the in-memory session.
    public func signOut() async {
        try? await client.auth.signOut()
        state = .signedOut(reason: nil)
    }

    /// Invite and recovery both land here. The redirect is the web's callback so
    /// one URL serves both clients (architecture.md §4).
    public func sendPasswordReset(email: String) async throws {
        try await client.auth.resetPasswordForEmail(
            email,
            redirectTo: URL(string: "https://apextrainingcalendar.vercel.app/auth/callback")
        )
    }

    public func expire(reason: String) {
        state = .signedOut(reason: reason)
    }
}
