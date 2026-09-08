import ApexCore
import BackgroundTasks
import Foundation
import Network
import UIKit

/// The write queue's flush triggers (architecture.md §7). The queue itself is a
/// pure state machine in `ApexCore`; this is the Apple-specific part that tells
/// it *when*: the network path coming back, the scene becoming active, the
/// scene going to the background (the web's `visibilitychange` flush, with a
/// background task so iOS lets it finish), and an opportunistic
/// `BGAppRefreshTask`. Nothing here is unit-testable, which is why it lives in
/// the app target rather than `ApexKit`.
@MainActor
final class WriteQueueDriver {
    static let taskIdentifier = "com.shanehaynes.apextraining.queue-flush"

    /// The queue the background task flushes. Set while a user is signed in.
    nonisolated(unsafe) private static var current: WriteQueue?

    private let queue: WriteQueue
    private let monitor = NWPathMonitor()
    private var wasSatisfied = true

    init(queue: WriteQueue) {
        self.queue = queue
        Self.current = queue
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in self?.pathChanged(satisfied: path.status == .satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "apex.queue.path"))
    }

    func stop() {
        monitor.cancel()
        if Self.current === queue { Self.current = nil }
    }

    /// Registration has to happen before the app finishes launching, and only
    /// once — hence static, from `ApexApp.init`.
    static func registerBackgroundTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { return }
            let work = Task {
                if let queue = current { await queue.resume() }
                refresh.setTaskCompleted(success: true)
                scheduleAppRefresh()
            }
            refresh.expirationHandler = { work.cancel() }
        }
    }

    /// iOS decides when (and whether) this runs; it is a bonus, not a promise.
    static func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func sceneBecameActive() {
        Task { await queue.resume() }
    }

    /// The `visibilitychange → hidden` analog: flush now, under a background
    /// task so the send survives the transition, then ask for a refresh later.
    func sceneEnteredBackground() {
        var token = UIBackgroundTaskIdentifier.invalid
        token = UIApplication.shared.beginBackgroundTask(withName: "apex.queue.flush") {
            UIApplication.shared.endBackgroundTask(token)
            token = .invalid
        }
        Task {
            await queue.flush()
            if token != .invalid { UIApplication.shared.endBackgroundTask(token) }
        }
        Self.scheduleAppRefresh()
    }

    private func pathChanged(satisfied: Bool) {
        defer { wasSatisfied = satisfied }
        guard satisfied, !wasSatisfied else { return }
        Task { await queue.resume() }
    }
}
