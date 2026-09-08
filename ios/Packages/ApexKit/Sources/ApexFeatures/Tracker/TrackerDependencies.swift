import ApexCore
import Foundation

/// What the tracker needs from the app: the client, the read cache, the write
/// queue and the clock. Built once by `AppModel` per signed-in user (the queue
/// store is per owner) and handed to the Schedule tab.
public struct TrackerServices: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var queue: WriteQueue
    public var clock: any ApexClock

    public init(client: ApexClient, cache: any CacheStore, queue: WriteQueue, clock: any ApexClock = SystemClock()) {
        self.client = client
        self.cache = cache
        self.queue = queue
        self.clock = clock
    }
}

/// `TrackerServices` plus the two things only the Schedule tab can supply: the
/// cached exercise definitions (the swap picker's source — `search_exercises`
/// carries no ids) and the calendar's completion flip.
public struct TrackerDependencies: Sendable {
    public var services: TrackerServices
    public var definitions: @Sendable () async -> [ExerciseDefinition]
    public var onCompletionChanged: @MainActor @Sendable (_ event: ScheduleEvent, _ isCompleted: Bool, _ completedAt: String?) -> Void

    public init(
        services: TrackerServices,
        definitions: @escaping @Sendable () async -> [ExerciseDefinition],
        onCompletionChanged: @escaping @MainActor @Sendable (ScheduleEvent, Bool, String?) -> Void
    ) {
        self.services = services
        self.definitions = definitions
        self.onCompletionChanged = onCompletionChanged
    }
}

/// One presentation of the tracker: an occurrence on its date.
public struct TrackerRoute: Identifiable, Hashable, Sendable {
    public let event: ScheduleEvent
    public var id: String { "\(event.id)|\(event.date)" }
    public var session: SessionKey { SessionKey(eventId: event.id, eventDate: event.date) }

    public init(event: ScheduleEvent) {
        self.event = event
    }
}
