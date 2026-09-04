import Foundation

/// What every write endpoint answers on success (`/api/completions`,
/// `/api/workout-sessions quick-complete`, …). Nothing else comes back: a
/// client that wants the new state re-reads the window.
public struct OkResponse: Codable, Sendable, Equatable {
    public let ok: Bool
}
