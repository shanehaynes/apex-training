import Foundation

/// Keys under `CacheKind.analyticsTiles` and `.analyticsResult`
/// (architecture.md §6: `analytics_tiles`, `analytics_result:<tileId>`).
public enum AnalyticsCacheKey {
    public static let tiles = "all"

    /// One computed result per tile.
    public static func result(tileId: String) -> String { tileId }
}

/// What `analytics_result` holds: the result and what it was computed from.
/// An entry is reused only when its `spec` still equals the served spec and
/// its `today` is today's — no hash, no `updated_at` (which a layout PATCH
/// also bumps). Compute has no cache headers; the phone owns validity.
public struct CachedTileResult: Codable, Sendable, Equatable {
    public let spec: JSONValue
    public let today: String
    public let result: TileResult

    public init(spec: JSONValue, today: String, result: TileResult) {
        self.spec = spec
        self.today = today
        self.result = result
    }

    /// Whether this entry still describes `spec` on `today`.
    public func matches(spec: JSONValue?, today: String) -> Bool {
        self.today == today && self.spec == spec
    }
}

/// Why the dashboard is refreshing; decides who hears about a failure and
/// whether cached results are trusted (`.launch` and `.realtime` reuse a
/// matching cache entry; everything else recomputes — realtime on
/// `analytics_tiles` says nothing about the logs behind a tile).
public enum AnalyticsRefreshReason: Sendable, Equatable {
    case launch, foreground, realtime, afterSave, pullToRefresh, retry

    /// Whether a cached result whose spec and day match may stand in for a compute.
    public var trustsCache: Bool {
        switch self {
        case .launch, .realtime: true
        case .foreground, .afterSave, .pullToRefresh, .retry: false
        }
    }

    /// Whether a failure is the user's doing and deserves a toast.
    public var isUserInitiated: Bool {
        switch self {
        case .pullToRefresh, .retry: true
        default: false
        }
    }
}
