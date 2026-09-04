import Foundation

/// An in-memory `CacheStore`: the fallback when the SQLite file will not open,
/// and the store every model test runs against. Same contract, no disk.
public actor MemoryCacheStore: CacheStore {
    private var entries: [String: CacheEntry] = [:]

    public init() {}

    public func read(kind: CacheKind, key: String) async throws -> CacheEntry? {
        entries["\(kind.rawValue)/\(key)"]
    }

    public func write(_ entry: CacheEntry) async throws {
        entries["\(entry.kind.rawValue)/\(entry.key)"] = entry
    }

    public func purge(kind: CacheKind) async throws {
        entries = entries.filter { !$0.key.hasPrefix("\(kind.rawValue)/") }
    }

    /// For tests: everything written so far.
    public var all: [CacheEntry] { Array(entries.values) }
}
