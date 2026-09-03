import Foundation

/// What the read cache holds. One case per window or collection the app renders
/// offline (architecture.md §6).
public enum CacheKind: String, Sendable, CaseIterable {
    case scheduleWindow = "schedule_window"
    case definitions
    case templates
    case blocks
    case objectives
    case mealsWindow = "meals_window"
    case profile
    case analyticsTiles = "analytics_tiles"
    case analyticsResult = "analytics_result"
    case trackerBootstrap = "tracker_bootstrap"
}

public struct CacheEntry: Sendable, Equatable {
    public let kind: CacheKind
    public let key: String
    public let json: Data
    public let fetchedAt: Date

    public init(kind: CacheKind, key: String, json: Data, fetchedAt: Date) {
        self.kind = kind
        self.key = key
        self.json = json
        self.fetchedAt = fetchedAt
    }
}

/// Implemented by `ApexPersistence` over GRDB; faked in tests.
public protocol CacheStore: Sendable {
    func read(kind: CacheKind, key: String) async throws -> CacheEntry?
    func write(_ entry: CacheEntry) async throws
    func purge(kind: CacheKind) async throws
}

/// Stale-while-revalidate (D-007): render the cached value immediately, refresh
/// on foreground and on realtime events, and only admit to being stale when a
/// refresh has actually failed.
public struct CachePolicy: Sendable {
    /// Past this age the entry is worth mentioning to the user — but only if the
    /// last refresh failed. A successful refresh replaces it and the question
    /// never arises.
    public static let staleAfter: TimeInterval = 60 * 60

    public static func isStale(_ entry: CacheEntry, now: Date) -> Bool {
        now.timeIntervalSince(entry.fetchedAt) > staleAfter
    }
}
