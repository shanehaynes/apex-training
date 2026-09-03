import Foundation

/// All `ApexCore` knows about auth. `ApexAuth` supplies the supabase-swift
/// implementation; tests supply a fake.
public protocol TokenProvider: Sendable {
    func accessToken() async throws -> String
    /// Returns a fresh token, or throws if the session cannot be renewed.
    func refresh() async throws -> String
    func signOut() async
}
