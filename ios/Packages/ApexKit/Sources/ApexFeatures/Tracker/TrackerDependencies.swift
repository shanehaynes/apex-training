import ApexActivity
import ApexCore
import Foundation

/// What the tracker needs from the app: the client, the read cache, the write
/// queue, the clock and the Live Activity (W12). Built once by `AppModel` per
/// signed-in user (the queue store is per owner) and handed to the Schedule tab.
public struct TrackerServices: Sendable {
    public var client: ApexClient
    public var cache: any CacheStore
    public var queue: WriteQueue
    public var clock: any ApexClock
    public var activity: any TrackerActivityPublishing
    /// The running session, for anything outside the cover that has to say so
    /// — today the Day view's card (ux-review §3.4). One per signed-in user,
    /// like the queue, because it dies with the services that hold it.
    public var live: LiveSessionStore

    public init(
        client: ApexClient, cache: any CacheStore, queue: WriteQueue, clock: any ApexClock = SystemClock(),
        activity: any TrackerActivityPublishing = NoActivityPublisher(), live: LiveSessionStore = LiveSessionStore()
    ) {
        self.client = client
        self.cache = cache
        self.queue = queue
        self.clock = clock
        self.activity = activity
        self.live = live
    }
}

/// `TrackerServices` plus the two things only the Schedule tab can supply: the
/// cached exercise definitions (the swap picker's source — `search_exercises`
/// carries no ids) and the calendar's completion flip.
public struct TrackerDependencies: Sendable {
    public var services: TrackerServices
    public var definitions: @Sendable () async -> [ExerciseDefinition]
    public var onCompletionChanged: @MainActor @Sendable (_ event: ScheduleEvent, _ isCompleted: Bool, _ completedAt: String?) -> Void
    /// The swap picker's inline create — the library's write, so the new row
    /// lands in the cache every other picker reads.
    public var createDefinition: @MainActor @Sendable (_ name: String, _ category: String, _ isUnilateral: Bool) async -> ExerciseDefinition?

    public init(
        services: TrackerServices,
        definitions: @escaping @Sendable () async -> [ExerciseDefinition],
        onCompletionChanged: @escaping @MainActor @Sendable (ScheduleEvent, Bool, String?) -> Void,
        createDefinition: @escaping @MainActor @Sendable (String, String, Bool) async -> ExerciseDefinition? = { _, _, _ in nil }
    ) {
        self.services = services
        self.definitions = definitions
        self.onCompletionChanged = onCompletionChanged
        self.createDefinition = createDefinition
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
