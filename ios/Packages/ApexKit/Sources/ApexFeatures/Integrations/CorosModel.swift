import ApexCore
import ApexUI
import Foundation
import Observation

/// The COROS connection and its two-phase sync — `useProviderSync.ts` ported.
/// Sync previews, queues every proposed FILL for a per-item yes/no (unmatched
/// activities import without asking), then sends ONE apply with every
/// decision: fill on yes, standalone create on no. Nothing is written until
/// that apply, so backing out mid-queue changes nothing (U30 puts the queue
/// in a bottom sheet rather than a top-right popover).
@MainActor
@Observable
public final class CorosModel {
    private let services: YouServices

    public private(set) var connection: ProviderConnection?
    /// The status read failed and nothing is known — the root hides the row
    /// rather than show "Not connected" on a guess.
    public private(set) var isUnknown = true
    public private(set) var isConnecting = false
    public private(set) var isSyncing = false
    /// FILL proposals awaiting the user; the head is the one on screen.
    public private(set) var queue: [SyncProposal] = []
    private var decisions: [SyncDecision] = []
    /// Double-tap latch (`settleLatchRef`): a second tap must not settle the
    /// head twice while the first is still being applied.
    private var isSettling = false

    public init(services: YouServices) {
        self.services = services
    }

    // Under the package's MainActor default isolation the deinit would be
    // isolated, and a model released while a hosting view tears down (the
    // snapshot tests) hops executors twice — YouModel's, then its sub-models' —
    // which the iOS 17 back-deployed runtime aborts on (a double free inside
    // swift_task_deinitOnExecutor). Nothing here needs the actor to die.
    nonisolated deinit {}

    /// `configured` is false when the deployment has no COROS credentials at
    /// all, in which case the section is hidden rather than shown as disconnected.
    public var isConfigured: Bool { connection?.configured ?? false }
    public var status: ProviderConnection.Status { connection?.known ?? .disconnected }
    public var autoSync: Bool { connection?.autoSync ?? true }
    public var pendingFillCount: Int { connection?.pendingFillCount ?? 0 }
    public var lastSyncedLabel: String { IsoDate.when(connection?.lastSyncedAt, timeZone: services.timeZone) }
    public var head: SyncProposal? { queue.first }

    public var statusLabel: String {
        switch status {
        case .connected: "Connected"
        case .expired: "Reconnect needed"
        case .pending, .disconnected: "Not connected"
        }
    }

    // MARK: - Status

    public func refreshStatus() async {
        do {
            connection = try await services.client.send(.providerStatus, as: ProviderStatusResponse.self).coros
            isUnknown = false
        } catch {
            // Leave whatever was known; the root row waits for a good read.
        }
    }

    // MARK: - Connect

    /// Begin the OAuth dance. `open` presents the authorize URL (an
    /// `ASWebAuthenticationSession` in the view) and returns the callback the
    /// server redirected to — `apextraining://connected` or `connect_error`,
    /// which is what closes the browser (D-028). A URL already on the app's
    /// scheme is the callback itself: the fixture mock answers that way so the
    /// smoke can connect without a browser.
    public func connect(open: @MainActor (URL) async throws -> URL) async {
        guard !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }
        do {
            let start = try await services.client.send(.providerConnectStart(), as: ConnectStartResponse.self)
            guard let url = URL(string: start.authorizeUrl) else {
                ToastBus.shared.post("COROS sent an unusable sign-in link.", level: .failure)
                return
            }
            let callback = url.scheme?.lowercased() == DeepLink.scheme ? url : try await open(url)
            guard let link = DeepLink.parse(callback) else { return }
            await handleCallback(link)
        } catch is CancellationError {
            // The user closed the browser.
        } catch {
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    /// The callback's outcome, whether it arrived through the in-app browser
    /// or as a plain deep link (`AppModel.open` forwards those too).
    public func handleCallback(_ link: DeepLink) async {
        switch link {
        case .connected:
            ToastBus.shared.post("COROS connected — press Sync to grab activities", level: .success)
            await refreshStatus()
        case .connectError(_, let reason):
            ToastBus.shared.post(Self.failureMessage(reason: reason), level: .failure)
            await refreshStatus()
        default:
            break
        }
    }

    /// The callback's closed vocabulary (D-028): `denied` · `missing_code` ·
    /// `expired` · `exchange_failed`. Anything else gets the web's line.
    public static func failureMessage(reason: String?) -> String {
        switch reason {
        case "denied": "COROS connection declined — nothing was linked."
        case "expired": "The COROS sign-in expired — try again."
        default: "COROS connection failed — try again."
        }
    }

    public func disconnect() async {
        do {
            _ = try await services.client.data(for: .providerDisconnect())
            await refreshStatus()
            ToastBus.shared.post("COROS disconnected")
        } catch {
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    /// Optimistic — the toggle answers immediately; a failure reverts.
    public func setAutoSync(_ enabled: Bool) async {
        guard let current = connection, current.autoSync != enabled else { return }
        connection = current.with(autoSync: enabled)
        do {
            let response = try await services.client.send(.providerAutoSync(enabled: enabled), as: AutoSyncResponse.self)
            connection = connection?.with(autoSync: response.autoSync)
        } catch {
            connection = current
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    // MARK: - Sync

    /// Preview → queue the matches → (apply when nothing needs asking).
    public func sync() async {
        guard !isSyncing else { return }
        isSyncing = true
        decisions = []
        let preview: SyncPreviewResponse
        do {
            preview = try await services.client.send(.providerPreview(timezone: services.timeZone.identifier), as: SyncPreviewResponse.self)
        } catch {
            isSyncing = false
            if case APIError.server(409, _) = error {
                connection = connection?.with(status: ProviderConnection.Status.expired.rawValue)
                ToastBus.shared.post("COROS connection expired — reconnect below", level: .failure)
            } else {
                ToastBus.shared.post(Failure.message(error), level: .failure)
            }
            return
        }
        // Unmatched activities import without confirmation (decided product
        // behaviour) — they go straight into the decision list.
        decisions = preview.proposals.filter { !$0.needsConfirmation }.map { .create(activityId: $0.activity.activityId) }
        let fills = preview.proposals.filter(\.needsConfirmation)
        if fills.isEmpty {
            await apply()
        } else {
            isSettling = false
            queue = fills
            // isSyncing stays true; apply runs when the queue settles.
        }
    }

    /// Settle the head: fill on yes, standalone create on no.
    public func settle(fill: Bool) async {
        guard !isSettling, let head = queue.first else { return }
        isSettling = true
        if fill, let match = head.match {
            decisions.append(.fill(activityId: head.activity.activityId, targetEventId: match.eventId, eventDate: match.eventDate))
        } else {
            decisions.append(.create(activityId: head.activity.activityId))
        }
        queue.removeFirst()
        if queue.isEmpty {
            await apply()
        }
        isSettling = false
    }

    /// Dismissing the sheet mid-queue: nothing has been written, and the
    /// activities are still on the watch for the next sync.
    public func abandonQueue() {
        guard !queue.isEmpty else { return }
        queue = []
        decisions = []
        isSyncing = false
        ToastBus.shared.post("Sync cancelled — nothing was imported")
    }

    private func apply() async {
        defer { isSyncing = false }
        guard !decisions.isEmpty else {
            ToastBus.shared.post("Everything up to date")
            return
        }
        let sent = decisions
        decisions = []
        do {
            let outcome = try await services.client.send(
                .providerApply(timezone: services.timeZone.identifier, decisions: sent), as: SyncApplyOutcome.self
            )
            ToastBus.shared.post(Self.summary(outcome), level: outcome.errors.isEmpty ? .success : .failure)
            connection = connection?.with(lastSyncedAt: CompletionRows.isoTimestamp(services.clock.now), pendingFillCount: 0)
            services.onScheduleChanged()
        } catch {
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    /// "COROS: Imported 1 activity · filled 2 planned workouts" — the web's toast.
    public static func summary(_ outcome: SyncApplyOutcome) -> String {
        var parts: [String] = []
        if outcome.created > 0 { parts.append("imported \(outcome.created) \(outcome.created == 1 ? "activity" : "activities")") }
        if outcome.filled > 0 { parts.append("filled \(outcome.filled) planned \(outcome.filled == 1 ? "workout" : "workouts")") }
        if !outcome.errors.isEmpty { parts.append("\(outcome.errors.count) failed") }
        let joined = parts.isEmpty ? "nothing new" : parts.joined(separator: " · ")
        return "COROS: " + joined.prefix(1).uppercased() + joined.dropFirst()
    }

    /// "Trail Run · 7:05 AM · 5.20 mi — fill planned “Planned Morning Run”?"
    public static func fillPrompt(_ proposal: SyncProposal) -> String {
        let activity = proposal.activity
        let facts = [activity.sportLabel, activity.displayTime, activity.distance ?? "\(activity.durationMin) min"].joined(separator: " · ")
        return "\(facts) — fill planned “\(proposal.match?.title ?? "")”?"
    }
}

extension ProviderConnection {
    func with(status: String? = nil, autoSync: Bool? = nil, lastSyncedAt: String?? = nil, pendingFillCount: Int? = nil) -> ProviderConnection {
        ProviderConnection(
            status: status ?? self.status,
            lastSyncedAt: lastSyncedAt ?? self.lastSyncedAt,
            connectedAt: connectedAt,
            autoSync: autoSync ?? self.autoSync,
            pendingFillCount: pendingFillCount ?? self.pendingFillCount,
            configured: configured
        )
    }
}
