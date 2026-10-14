import ApexCore
import Foundation
import HealthKit

/// HealthKit behind `HealthStore`. Apex writes workouts only (M1): no samples,
/// no energy and no heart rate it did not measure (W16, D-056).
public nonisolated final class HKHealthStoreAdapter: HealthStore, @unchecked Sendable {
    private let store = HKHealthStore()

    public init() {}

    public func workoutWriteAuthorization() -> HealthAuthorization {
        guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
        switch store.authorizationStatus(for: HKObjectType.workoutType()) {
        case .sharingAuthorized: return .authorized
        case .sharingDenied: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    public func requestWorkoutWriteAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try await store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [])
    }

    public func save(_ draft: HealthWorkoutDraft) async throws {
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = draft.kind.workoutActivityType
        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        try await builder.beginCollection(at: draft.start)
        try await builder.addMetadata([
            HKMetadataKeySyncIdentifier: draft.syncIdentifier,
            HKMetadataKeySyncVersion: draft.syncVersion,
            HKMetadataKeyExternalUUID: draft.syncIdentifier,
            HKMetadataKeyWorkoutBrandName: "Apex",
            Self.titleKey: draft.title,
        ])
        try await builder.endCollection(at: draft.end)
        _ = try await builder.finishWorkout()
    }

    public func deleteWorkouts(syncIdentifier: String) async throws {
        let predicate = HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: [syncIdentifier])
        _ = try await store.deleteObjects(of: HKObjectType.workoutType(), predicate: predicate)
    }

    /// Health has no title field; the workout's name rides in Apex's own key.
    static let titleKey = "ApexWorkoutTitle"
}

extension HealthActivityKind {
    nonisolated var workoutActivityType: HKWorkoutActivityType {
        switch self {
        case .traditionalStrengthTraining: .traditionalStrengthTraining
        case .functionalStrengthTraining: .functionalStrengthTraining
        case .climbing: .climbing
        case .running: .running
        case .cycling: .cycling
        case .swimming: .swimming
        case .mixedCardio: .mixedCardio
        case .yoga: .yoga
        case .flexibility: .flexibility
        case .other: .other
        }
    }
}
