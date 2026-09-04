import Foundation

/// Which cached window a realtime table change invalidates. Declared here, not
/// in `ApexAuth`, so a feature model can observe changes without knowing what
/// delivers them (supabase-swift in the app, a fake in tests).
public enum TableGroup: String, Sendable, CaseIterable {
    case schedule, blocks, meals, analytics
}

public protocol RealtimeChanges: Sendable {
    var changes: AsyncStream<TableGroup> { get }
    /// Idempotent. A model subscribes to the group it renders when it starts;
    /// the app suspends and resumes the whole set with the scene.
    func subscribe(_ group: TableGroup) async
    func unsubscribe(_ group: TableGroup) async
}
