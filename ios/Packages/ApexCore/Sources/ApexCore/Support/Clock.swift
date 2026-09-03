import Foundation

/// Time, injected. Retry backoff and cache staleness both need it, and neither
/// is testable against the real clock.
public protocol ApexClock: Sendable {
    var now: Date { get }
    func sleep(seconds: Double) async throws
}

public struct SystemClock: ApexClock {
    public init() {}
    public var now: Date { Date() }
    public func sleep(seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}

/// Never actually waits: `sleep` records the interval and jumps the clock, so a
/// test asserting on backoff runs instantly instead of in real seconds.
public final class TestClock: ApexClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    private var recorded: [Double] = []

    public init(now: Date = Date(timeIntervalSince1970: 0)) {
        self.current = now
    }

    public var now: Date { withLock { current } }

    /// Every interval `sleep(seconds:)` was asked for, in order.
    public var sleeps: [Double] { withLock { recorded } }

    public func sleep(seconds: Double) async throws {
        withLock {
            recorded.append(seconds)
            current = current.addingTimeInterval(seconds)
        }
    }

    public func advance(by seconds: Double) {
        withLock { current = current.addingTimeInterval(seconds) }
    }

    private func withLock<R>(_ body: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
