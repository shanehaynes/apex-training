import Foundation

/// An in-memory `WriteQueueStore`: the store every queue test runs against and
/// the fallback when the SQLite file will not open (nothing then survives a
/// relaunch, which is still better than refusing to log a workout).
public actor MemoryWriteQueueStore: WriteQueueStore {
    private var ops: [TrackerOp] = []
    private var nextId: Int64 = 1

    public init() {}

    public func append(_ op: TrackerOp) async throws -> Int64 {
        var stored = op
        stored.id = nextId
        nextId += 1
        ops.append(stored)
        return stored.id
    }

    public func update(_ op: TrackerOp) async throws {
        guard let i = ops.firstIndex(where: { $0.id == op.id }) else { return }
        ops[i] = op
    }

    public func delete(id: Int64) async throws {
        ops.removeAll { $0.id == id }
    }

    public func tail(for session: SessionKey) async throws -> TrackerOp? {
        ops.last { $0.session == session }
    }

    public func nextPending(for session: SessionKey) async throws -> TrackerOp? {
        ops.first { $0.session == session && $0.state == .pending }
    }

    public func ops(for session: SessionKey) async throws -> [TrackerOp] {
        ops.filter { $0.session == session }
    }

    public func sessionsWithPending() async throws -> [SessionKey] {
        var seen: [SessionKey] = []
        for op in ops where op.state == .pending && !seen.contains(op.session) { seen.append(op.session) }
        return seen
    }

    public func purge(session: SessionKey) async throws {
        ops.removeAll { $0.session == session }
    }

    public func purgeAll() async throws {
        ops = []
    }

    /// For tests: everything stored, oldest first.
    public var all: [TrackerOp] { ops }
}
