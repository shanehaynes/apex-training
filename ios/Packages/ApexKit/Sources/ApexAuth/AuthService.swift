import ApexCore
import Foundation
import Supabase

public enum AuthState: Equatable, Sendable {
    /// Before the stored session has been read. The root shows a splash, not the
    /// sign-in screen — flashing sign-in at a signed-in user is the bug this
    /// case exists to prevent.
    case restoring
    case signedOut(reason: String?)
    /// A session exists but arrived through an invite or recovery link: the
    /// set-password screen holds until a password lands (`SetPasswordView.tsx`
    /// on the web does the same). Every other auth event keeps it held.
    case needsPassword(userID: String, email: String?)
    case signedIn(userID: String, email: String?)
}

/// What handling an auth link produced, for the caller's toast or route.
public enum AuthLinkOutcome: Equatable, Sendable {
    case signedIn
    case needsPassword
    case failed(String)
}

/// supabase-swift's Auth, wrapped so the rest of the app never imports the SDK.
@MainActor
@Observable
public final class AuthService {
    public private(set) var state: AuthState = .restoring

    private let client: SupabaseClient
    private var watcher: Task<Void, Never>?
    /// Set before the SDK is asked for a session that must end on set-password,
    /// so the auth event that follows maps to `.needsPassword`, not `.signedIn`.
    private var holdForPassword = false

    /// The app asked for a reset. A PKCE redirect (`?code=`) carries no `type`
    /// (verified in supabase-swift 2.55.1: only the implicit path emits
    /// PASSWORD_RECOVERY), so this note is what turns the next code exchange
    /// into a set-password screen. Survives a relaunch: the email is opened later.
    private static let pendingRecoveryKey = "apex.pendingRecovery"

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
                case .passwordRecovery:
                    holdForPassword = true
                    if let session { state = .needsPassword(userID: session.user.id.uuidString, email: session.user.email) }
                case .initialSession, .signedIn, .tokenRefreshed, .userUpdated:
                    if let session {
                        state = holdForPassword
                            ? .needsPassword(userID: session.user.id.uuidString, email: session.user.email)
                            : .signedIn(userID: session.user.id.uuidString, email: session.user.email)
                    } else {
                        state = .signedOut(reason: nil)
                    }
                case .signedOut:
                    holdForPassword = false
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
        holdForPassword = false
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
        UserDefaults.standard.set(true, forKey: Self.pendingRecoveryKey)
    }

    public func expire(reason: String) {
        state = .signedOut(reason: reason)
    }

    // MARK: - Links

    /// Turns an auth deep link into a session. Two shapes (architecture.md §3):
    /// `?code=` is the PKCE exchange for a reset this app requested;
    /// `#access_token…` is the implicit hand-off from the web, which a PKCE
    /// client refuses in `session(from:)` and so goes through `setSession`.
    public func handle(_ link: DeepLink, originalURL: URL) async -> AuthLinkOutcome {
        switch link {
        case .authCode(_, let type):
            let pending = UserDefaults.standard.bool(forKey: Self.pendingRecoveryKey)
            let wantsPassword = pending || (type?.needsPassword ?? false)
            holdForPassword = wantsPassword
            do {
                _ = try await client.auth.session(from: originalURL)
                UserDefaults.standard.removeObject(forKey: Self.pendingRecoveryKey)
                return wantsPassword ? .needsPassword : .signedIn
            } catch {
                holdForPassword = false
                return .failed(Self.readable(error))
            }

        case .authTokens(let accessToken, let refreshToken, let type):
            let wantsPassword = type?.needsPassword ?? false
            holdForPassword = wantsPassword
            do {
                _ = try await client.auth.setSession(accessToken: accessToken, refreshToken: refreshToken)
                return wantsPassword ? .needsPassword : .signedIn
            } catch {
                holdForPassword = false
                return .failed(Self.readable(error))
            }

        case .authError(let error):
            // The caller shows the reason; nobody gets signed out over a spent link.
            return .failed(error.message)

        default:
            return .failed("Not a sign-in link.")
        }
    }

    /// The set-password screen's submit. Releases the hold, so the next auth
    /// event (USER_UPDATED) lands on `.signedIn`.
    public func setPassword(_ password: String) async throws {
        _ = try await client.auth.update(user: UserAttributes(password: password))
        holdForPassword = false
        UserDefaults.standard.removeObject(forKey: Self.pendingRecoveryKey)
        if let session = try? await client.auth.session {
            state = .signedIn(userID: session.user.id.uuidString, email: session.user.email)
        }
    }

    private static func readable(_ error: Error) -> String {
        let message = error.localizedDescription
        if message.localizedCaseInsensitiveContains("expired") || message.localizedCaseInsensitiveContains("invalid") {
            return AuthLinkError.expiredMessage
        }
        return message
    }
}
