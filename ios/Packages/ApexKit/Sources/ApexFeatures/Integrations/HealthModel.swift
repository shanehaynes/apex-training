import ApexCore
import ApexHealth
import ApexUI
import Foundation
import Observation

/// You → Apple Health (W16 M1): one choice — write finished workouts to
/// Health — and where Health's own permission stands. The choice is this
/// account's on this phone until M2 moves it to the server.
@MainActor
@Observable
public final class HealthModel {
    private let services: HealthServices

    public private(set) var authorization: HealthAuthorization
    public private(set) var writesWorkouts: Bool
    public private(set) var isRequesting = false

    public init(services: HealthServices) {
        self.services = services
        self.authorization = services.store.workoutWriteAuthorization()
        self.writesWorkouts = services.preferences.writesWorkouts
    }

    // Under the package's MainActor default isolation the deinit would be
    // isolated; a model released while a hosting view tears down hops
    // executors, which the iOS 17 back-deployed runtime aborts on (D-031).
    nonisolated deinit {}

    public var isAvailable: Bool { authorization != .unavailable }
    public var isDenied: Bool { writesWorkouts && authorization == .denied }
    public var isWriting: Bool { writesWorkouts && authorization == .authorized }

    public var statusLabel: String {
        guard isAvailable else { return "Not available" }
        if isWriting { return "Writing workouts" }
        return isDenied ? "Denied in Health" : "Off"
    }

    /// Health's permission can change in Settings while Apex is in the
    /// background; the screen re-reads it every time it appears.
    public func refresh() {
        authorization = services.store.workoutWriteAuthorization()
        writesWorkouts = services.preferences.writesWorkouts
    }

    /// Turning it on asks Health first (the system sheet, once); the choice is
    /// kept even when Health says no, so allowing Apex later in Health is all
    /// it takes. Turning it off never touches what is already in Health.
    public func setWritesWorkouts(_ on: Bool) async {
        if on {
            isRequesting = true
            defer { isRequesting = false }
            do {
                try await services.store.requestWorkoutWriteAuthorization()
            } catch {
                ToastBus.shared.post("Could not ask Apple Health: \(error.localizedDescription)", level: .failure)
                refresh()
                return
            }
        }
        services.preferences.setWritesWorkouts(on)
        refresh()
    }
}
