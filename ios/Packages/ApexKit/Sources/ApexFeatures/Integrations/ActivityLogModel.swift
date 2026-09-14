import ApexCore
import Foundation
import Observation

/// `GET /api/mutations-log` (`CoachActivity.tsx`): every schedule and library
/// change, and whether the user or the coach made it. Read-only; a failure
/// shows the empty state rather than a toast, as the web hides the section.
@MainActor
@Observable
public final class ActivityLogModel {
    private let services: YouServices

    public private(set) var entries: [ActivityLogEntry]?
    public private(set) var failed = false

    public init(services: YouServices) {
        self.services = services
    }

    // Under the package's MainActor default isolation the deinit would be
    // isolated, and a model released while a hosting view tears down (the
    // snapshot tests) hops executors twice — YouModel's, then its sub-models' —
    // which the iOS 17 back-deployed runtime aborts on (a double free inside
    // swift_task_deinitOnExecutor). Nothing here needs the actor to die.
    nonisolated deinit {}

    public func load() async {
        do {
            entries = try await services.client.send(.mutationsLog, as: ActivityLogResponse.self).entries
            failed = false
        } catch {
            failed = true
        }
    }

    /// "Created" · "Skipped occurrence of" … — `OPERATION_LABELS`, with the
    /// raw operation for one this build does not know.
    public static func operationLabel(_ operation: String) -> String {
        switch operation {
        case "create": "Created"
        case "update": "Updated"
        case "delete": "Deleted"
        case "delete_instance": "Skipped occurrence of"
        case "update_instance": "Rescheduled occurrence of"
        case "archive": "Archived"
        case "unarchive": "Unarchived"
        default: operation
        }
    }

    /// " (library)" for a definition, " · 2026-09-08" for a dated event.
    public static func suffix(_ entry: ActivityLogEntry) -> String {
        var s = entry.source == "definition" ? " (library)" : ""
        if let date = entry.eventDate { s += " · \(date)" }
        return s
    }

    public func time(_ entry: ActivityLogEntry) -> String {
        IsoDate.logTime(entry.loggedAt, timeZone: services.timeZone)
    }
}
