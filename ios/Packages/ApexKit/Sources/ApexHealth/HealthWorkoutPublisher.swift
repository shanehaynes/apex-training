import ApexCore
import Foundation
import OSLog

/// What the tracker tells Apple Health, at the two moments that matter: a
/// session finished, a session was cancelled. `TrackerModel` speaks to this
/// protocol the way it speaks to `TrackerActivityPublishing`; tests inject a
/// spy, previews get `NoHealthPublisher`.
public nonisolated protocol HealthWorkoutPublishing: Sendable {
    func workoutFinished(_ draft: HealthWorkoutDraft) async
    func workoutCancelled(_ session: SessionKey) async
}

public nonisolated struct NoHealthPublisher: HealthWorkoutPublishing {
    public init() {}
    public func workoutFinished(_ draft: HealthWorkoutDraft) async {}
    public func workoutCancelled(_ session: SessionKey) async {}
}

/// The app's publisher. A write needs the user's opt-in *and* Health's
/// permission; a delete needs only the permission — a workout Apex already
/// wrote goes when its session is cancelled, even if writing was turned off
/// since. Failures are logged, never surfaced: Health is a mirror of the
/// workout, and the workout itself is already safe in the queue.
public nonisolated struct HealthWorkoutPublisher: HealthWorkoutPublishing {
    private let store: any HealthStore
    private let preferences: HealthPreferences
    private static let log = Logger(subsystem: "com.shanehaynes.apextraining", category: "health")

    public init(store: any HealthStore, preferences: HealthPreferences) {
        self.store = store
        self.preferences = preferences
    }

    public func workoutFinished(_ draft: HealthWorkoutDraft) async {
        guard preferences.writesWorkouts, store.workoutWriteAuthorization() == .authorized else { return }
        do {
            try await store.save(draft)
        } catch {
            Self.log.error("workout save failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func workoutCancelled(_ session: SessionKey) async {
        guard store.workoutWriteAuthorization() == .authorized else { return }
        do {
            try await store.deleteWorkouts(syncIdentifier: HealthWorkoutDraft.syncIdentifier(for: session))
        } catch {
            Self.log.error("workout delete failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
