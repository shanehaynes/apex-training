import ApexCore
import ApexUI
import AuthenticationServices
import SwiftUI

/// COROS: connect / reconnect inside the app (`ASWebAuthenticationSession`
/// closed by the callback's scheme redirect, D-028), the nightly auto-sync
/// toggle, Sync now with the pending-fill badge, disconnect. The sync's
/// confirmation queue is a bottom sheet (U30).
public struct CorosView: View {
    private let model: CorosModel
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var confirmDisconnect = false

    public init(model: CorosModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                status
                switch model.status {
                case .connected: connected
                case .expired: expired
                case .disconnected, .pending: disconnected
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("COROS")
        .task { await model.refreshStatus() }
        .sheet(isPresented: Binding(get: { model.head != nil }, set: { if !$0 { model.abandonQueue() } })) {
            if let head = model.head {
                SyncConfirmationSheet(
                    proposal: head, remaining: model.queue.count - 1,
                    onKeep: { Task { await model.settle(fill: false) } },
                    onFill: { Task { await model.settle(fill: true) } }
                )
                .presentationDetents([.height(300)])
                .presentationDragIndicator(.visible)
                .presentationBackground(ApexColor.bgSurface)
            }
        }
        .confirmationDialog("Disconnect COROS?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await model.disconnect() } }
                .accessibilityIdentifier("coros.disconnect.confirm")
        } message: {
            Text("Imported activities stay on the calendar. You can connect again any time.")
        }
    }

    private var status: some View {
        HStack(spacing: Spacing.md) {
            ApexIcon.watch.image
                .font(.system(size: 22))
                .foregroundStyle(model.status == .connected ? ApexPalette.positive : ApexColor.textMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.statusLabel)
                    .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .accessibilityIdentifier("coros.status")
                if model.status == .connected {
                    Text("Last synced \(model.lastSyncedLabel)")
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var connected: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Hint("Sync pulls new activities off the watch — heart rate, GPS, elevation — and offers to fill any planned workout they match.")
            ApexButton(model.isSyncing ? "Syncing…" : syncTitle, isLoading: model.isSyncing) {
                Task { await model.sync() }
            }
            .accessibilityIdentifier("coros.sync")
            .accessibilityLabel(syncTitle)
            SettingsSection(footer: "Every night around 11:30 PM ET, and matches wait for your confirmation — Sync shows a count when any are.") {
                SettingsToggle("Sync automatically", isOn: Binding(
                    get: { model.autoSync },
                    set: { enabled in Task { await model.setAutoSync(enabled) } }
                ), identifier: "coros.autosync")
            }
            ApexButton("Disconnect COROS", kind: .secondary) { confirmDisconnect = true }
                .accessibilityIdentifier("coros.disconnect")
        }
    }

    private var syncTitle: String {
        model.pendingFillCount > 0 ? "Sync now · \(model.pendingFillCount) waiting" : "Sync now"
    }

    private var expired: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Hint("The COROS connection expired — sign in again to keep syncing. Your imported activities are untouched.")
            connectButton("Reconnect COROS")
        }
    }

    private var disconnected: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Hint("Connect your COROS account to pull activities straight into the calendar — you sign in on COROS's own site, and Apex never sees the password.")
            connectButton("Connect COROS")
        }
    }

    private func connectButton(_ title: String) -> some View {
        ApexButton(model.isConnecting ? "Opening COROS…" : title, isLoading: model.isConnecting) {
            Task {
                await model.connect { url in
                    do {
                        return try await webAuth.authenticate(using: url, callbackURLScheme: DeepLink.scheme, preferredBrowserSession: .ephemeral)
                    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                        throw CancellationError()
                    }
                }
            }
        }
        .accessibilityIdentifier("coros.connect")
    }
}

/// One matched activity: keep it separate or fill the planned workout.
/// "N more after this" says how long the queue is.
public struct SyncConfirmationSheet: View {
    private let proposal: SyncProposal
    private let remaining: Int
    private let onKeep: () -> Void
    private let onFill: () -> Void

    public init(proposal: SyncProposal, remaining: Int, onKeep: @escaping () -> Void, onFill: @escaping () -> Void) {
        self.proposal = proposal
        self.remaining = remaining
        self.onKeep = onKeep
        self.onFill = onFill
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            HStack {
                Text("Sync from COROS").apexEyebrow()
                Spacer()
                if remaining > 0 {
                    Text("\(remaining) more after this")
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .accessibilityIdentifier("sync.remaining")
                }
            }
            HStack(alignment: .top, spacing: Spacing.md) {
                TypeChip(rawType: proposal.activity.apexType)
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(CorosModel.fillPrompt(proposal))
                        .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sync.prompt")
                    if let match = proposal.match {
                        Text("Planned \(match.eventDate)\(match.startTime.map { " at \($0)" } ?? "")" + (proposal.activity.avgHr.map { " · avg HR \($0)" } ?? ""))
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                    }
                }
            }
            HStack(spacing: Spacing.md) {
                ApexButton("Keep separate", kind: .secondary, action: onKeep)
                    .accessibilityIdentifier("sync.keep")
                ApexButton("Fill it", action: onFill)
                    .accessibilityIdentifier("sync.fill")
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.screen)
        .padding(.top, Spacing.sm)
        .background(ApexColor.bgSurface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sync.confirm")
    }
}
