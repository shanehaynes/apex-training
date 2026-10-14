import ApexCore
import Foundation

/// An in-memory Health store: the unit tests' and the `-apexMockHealth`
/// smoke's. Saves replace by sync identifier the way HealthKit's do, and a
/// request on an undecided store grants — the system sheet's "Allow".
public nonisolated final class FakeHealthStore: HealthStore, @unchecked Sendable {
    private let lock = NSLock()
    private var _authorization: HealthAuthorization
    private var _saved: [HealthWorkoutDraft] = []
    private var _requests = 0
    private let grantOnRequest: Bool

    public init(authorization: HealthAuthorization = .notDetermined, grantOnRequest: Bool = true) {
        _authorization = authorization
        self.grantOnRequest = grantOnRequest
    }

    /// What Health holds, newest save last.
    public var saved: [HealthWorkoutDraft] { lock.withLock { _saved } }
    public var requestCount: Int { lock.withLock { _requests } }

    public func setAuthorization(_ value: HealthAuthorization) { lock.withLock { _authorization = value } }

    public func workoutWriteAuthorization() -> HealthAuthorization { lock.withLock { _authorization } }

    public func requestWorkoutWriteAuthorization() async throws {
        lock.withLock {
            _requests += 1
            if _authorization == .notDetermined { _authorization = grantOnRequest ? .authorized : .denied }
        }
    }

    public func save(_ draft: HealthWorkoutDraft) async throws {
        lock.withLock {
            _saved.removeAll { $0.syncIdentifier == draft.syncIdentifier }
            _saved.append(draft)
        }
    }

    public func deleteWorkouts(syncIdentifier: String) async throws {
        lock.withLock { _saved.removeAll { $0.syncIdentifier == syncIdentifier } }
    }
}
