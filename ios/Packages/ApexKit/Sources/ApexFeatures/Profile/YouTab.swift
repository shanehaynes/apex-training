import ApexCore
import ApexUI
import SwiftUI

/// The You tab (D-012, W11): who you are, what the coach knows, what Apex is
/// connected to, what has been happening — the web's one long profile page
/// as grouped native sections (U24), each row pushing its own screen. Library,
/// Blocks and Meals join these sections in W10.
public struct YouTab: View {
    private let model: YouModel?

    public init(model: YouModel?) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            if let model {
                YouRootView(model: model)
            } else {
                EmptyState(eyebrow: "You", message: "Signing in…", symbol: ApexIcon.person.systemName)
                    .navigationTitle("You")
            }
        }
    }
}

public struct YouRootView: View {
    @Bindable private var model: YouModel

    public init(model: YouModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                header
                if let error = model.loadError, model.profile == nil {
                    loadFailed(error)
                } else {
                    sections
                }
            }
            .padding(Spacing.screen)
        }
        .background(ApexColor.bgPrimary)
        .navigationTitle("You")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationDestination(for: YouRoute.self) { route in destination(route) }
        .sheet(isPresented: $model.showKeySheet) {
            AnthropicKeyView(
                client: model.services.client, hasKey: model.profile?.hasAnthropicKey ?? false,
                last4: model.profile?.anthropicKeyLast4
            ) { _ in
                Task { await model.keyChanged() }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .task { await model.start() }
        .refreshable { await model.refreshProfile() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("you.root")
    }

    private var header: some View {
        NavigationLink(value: YouRoute.avatar) {
            HStack(spacing: Spacing.lg) {
                AvatarImage(key: model.avatarKey, size: 64)
                    .overlay(Circle().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.displayName)
                        .font(.apex(.display, size: TypeScale.xl, weight: .bold, relativeTo: .title2))
                        .tracking(-0.3)
                        .foregroundStyle(ApexColor.textPrimary)
                        .lineLimit(1)
                        .accessibilityIdentifier("you.name")
                    if let email = model.email {
                        Text(email)
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                if model.isLoading, model.profile == nil {
                    ProgressView().tint(ApexColor.textMuted)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("you.header")
    }

    private func loadFailed(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(message).apexBody().fixedSize(horizontal: false, vertical: true)
            ApexButton("Try again", kind: .secondary) { Task { await model.refreshProfile(initial: true) } }
            ApexButton("Sign out", kind: .secondary) { model.signOut() }
        }
    }

    @ViewBuilder
    private var sections: some View {
        SettingsSection("Account") {
            SettingsLink("Name", value: model.profile?.displayName?.nilIfBlank ?? "Add", symbol: ApexIcon.person.systemName, to: YouRoute.name, identifier: "you.row.name")
            SettingsDivider()
            SettingsLink("Avatar", value: Avatars.avatar(for: model.avatarKey).label, symbol: "face.smiling", to: YouRoute.avatar, identifier: "you.row.avatar")
            SettingsDivider()
            SettingsLink("Change password", symbol: ApexIcon.lock.systemName, to: YouRoute.password, identifier: "you.row.password")
        }

        SettingsSection("Training") {
            SettingsLink("Heart-rate zones", value: model.heartRateLabel, symbol: ApexIcon.heartPulse.systemName, to: YouRoute.heartRate, identifier: "you.row.heartrate")
        }

        SettingsSection("AI coach", footer: "The coach runs on your own Anthropic key — every chat, post-workout summary and monthly review is billed to it.") {
            SettingsLink("Goal & context", value: model.profile?.coachGoal?.nilIfBlank ?? "Not set", symbol: ApexIcon.flag.systemName, to: YouRoute.coachProfile, identifier: "you.row.coach")
            SettingsDivider()
            SettingsLink("Model", value: model.selectedModel?.label ?? model.profile?.coachModelLabel, symbol: ApexIcon.sparkles.systemName, to: YouRoute.coachModel, identifier: "you.row.model")
            SettingsDivider()
            SettingsButton("Anthropic key", value: model.keyStatusLabel, symbol: ApexIcon.key.systemName, identifier: "you.row.key") {
                model.showKeySheet = true
            }
        }

        SettingsSection("Integrations") {
            if model.coros.isConfigured {
                SettingsLink("COROS", value: model.coros.statusLabel, symbol: ApexIcon.watch.systemName, to: YouRoute.coros, identifier: "you.row.coros")
                SettingsDivider()
            }
            SettingsLink("Calendar feed", symbol: ApexIcon.calendar.systemName, to: YouRoute.calendarFeed, identifier: "you.row.feed")
            SettingsDivider()
            SettingsLink("AI connector", value: model.connector.statusLabel, symbol: ApexIcon.connector.systemName, to: YouRoute.connector, identifier: "you.row.connector")
        }

        SettingsSection("Data") {
            SettingsLink("Activity log", symbol: ApexIcon.activityLog.systemName, to: YouRoute.activity, identifier: "you.row.activity")
            SettingsDivider()
            SettingsLink("About", symbol: ApexIcon.info.systemName, to: YouRoute.about, identifier: "you.row.about")
            SettingsDivider()
            SettingsLink("Delete account", symbol: ApexIcon.trash.systemName, tone: .destructive, to: YouRoute.deleteAccount, identifier: "you.row.delete")
        }

        ApexButton("Sign out", kind: .secondary) { model.signOut() }
            .accessibilityIdentifier("you.signout")
            .padding(.top, Spacing.sm)
    }

    @ViewBuilder
    private func destination(_ route: YouRoute) -> some View {
        switch route {
        case .name: DisplayNameView(model: model)
        case .avatar: AvatarPickerView(model: model)
        case .password: ChangePasswordView(model: model)
        case .heartRate: HeartRateZonesView(model: model)
        case .coachProfile: CoachProfileView(model: model)
        case .coachModel: CoachModelPickerView(model: model)
        case .coros: CorosView(model: model.coros)
        case .calendarFeed: CalendarFeedView(model: model)
        case .connector: ConnectorView(model: model.connector)
        case .connectorGuide: ConnectorGuideView(endpoint: model.connector.endpoint)
        case .activity: ActivityLogView(model: model.activity)
        case .deleteAccount: DeleteAccountView(model: model)
        case .about: AboutView(model: model)
        }
    }
}

extension View {
    /// The chrome every pushed You screen shares: house background, inline
    /// title, opaque bar.
    func youScreen(_ title: String) -> some View {
        background(ApexColor.bgPrimary)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .tint(ApexColor.textPrimary)
    }
}

/// A muted paragraph under a screen's title — the web's `.profile-hint`.
struct Hint: View {
    private let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// An inline failure line under a form.
struct InlineError: View {
    private let text: String
    private let identifier: String

    init(_ text: String, identifier: String = "form.error") {
        self.text = text
        self.identifier = identifier
    }

    var body: some View {
        Text(text)
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexPalette.dangerText)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(identifier)
    }
}
