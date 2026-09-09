import ApexCore
import Foundation

/// What the Coach tab needs from the app: the client, the per-owner
/// conversation store, the clock, and a hook the app uses to refresh whatever
/// a confirmed coach action changed (the schedule window — realtime covers the
/// events table, not the completion a retro-log writes). Built once by
/// `AppModel` per signed-in user, like `TrackerServices`.
public struct CoachServices: Sendable {
    public var client: ApexClient
    public var store: any ConversationStore
    public var clock: any ApexClock
    public var timeZone: TimeZone
    public var onMutationConfirmed: @MainActor @Sendable () -> Void

    public init(
        client: ApexClient, store: any ConversationStore, clock: any ApexClock = SystemClock(),
        timeZone: TimeZone = .current, onMutationConfirmed: @escaping @MainActor @Sendable () -> Void = {}
    ) {
        self.client = client
        self.store = store
        self.clock = clock
        self.timeZone = timeZone
        self.onMutationConfirmed = onMutationConfirmed
    }
}
