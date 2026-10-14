import ApexCore
import Foundation

/// Where Apex stands with Apple Health for writing workouts. HealthKit only
/// reveals *share* authorization; that is all M1 asks for (W16, D-056).
public nonisolated enum HealthAuthorization: Sendable, Equatable {
    /// No Health store on this device.
    case unavailable
    /// Never asked.
    case notDetermined
    /// Asked and refused, or turned off later in Health › Sources › Apex.
    case denied
    case authorized
}

/// What Apex needs from HealthKit. The app injects `HKHealthStoreAdapter`; the
/// unit tests and the XCUITest smoke inject `FakeHealthStore`, because CI
/// simulators run unsigned (no entitlement) and hold no Health data.
public nonisolated protocol HealthStore: Sendable {
    func workoutWriteAuthorization() -> HealthAuthorization
    /// Shows the system sheet when nothing has been decided; a no-op otherwise.
    func requestWorkoutWriteAuthorization() async throws
    /// One Apex-branded workout. A draft with the same sync identifier as an
    /// earlier save replaces it.
    func save(_ draft: HealthWorkoutDraft) async throws
    /// Every workout Apex wrote under this identifier (none is fine).
    func deleteWorkouts(syncIdentifier: String) async throws
}

/// The one user choice M1 has, held on the phone and per signed-in account:
/// a second account on the same phone never inherits the first one's opt-in.
/// M2i moves the categories to the server's `apple` connection row.
public nonisolated struct HealthPreferences: Sendable {
    public let owner: String
    private let suiteName: String?

    /// `suiteName` is for tests and the mock: the app uses standard defaults.
    public init(owner: String, suiteName: String? = nil) {
        self.owner = owner
        self.suiteName = suiteName
    }

    public static func key(owner: String) -> String { "apex.health.\(owner).workoutsWrite" }

    private var defaults: UserDefaults { suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    /// Off until the user turns it on.
    public var writesWorkouts: Bool { defaults.bool(forKey: Self.key(owner: owner)) }

    public func setWritesWorkouts(_ on: Bool) {
        defaults.set(on, forKey: Self.key(owner: owner))
    }
}

/// The store and the choice, built once per signed-in user by `AppModel`.
public nonisolated struct HealthServices: Sendable {
    public var store: any HealthStore
    public var preferences: HealthPreferences

    public init(store: any HealthStore, preferences: HealthPreferences) {
        self.store = store
        self.preferences = preferences
    }

    public var publisher: HealthWorkoutPublisher { HealthWorkoutPublisher(store: store, preferences: preferences) }
}
