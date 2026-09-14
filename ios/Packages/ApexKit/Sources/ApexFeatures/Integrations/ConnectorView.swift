import ApexCore
import ApexUI
import SwiftUI

/// The AI connector: the endpoint, minting a token (one-time reveal), the
/// active tokens, the connected apps, and the guide.
public struct ConnectorView: View {
    @Bindable private var model: ConnectorModel
    @State private var revoking: McpToken?
    @State private var disconnecting: McpConnection?

    public init(model: ConnectorModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Hint("Query your training data from Claude or ChatGPT. Add this URL as a custom connector and sign in, or authenticate with an access token. Everything it can reach is read-only.")
                    NavigationLink(value: YouRoute.connectorGuide) {
                        HStack(spacing: Spacing.xs) {
                            ApexIcon.help.image
                            Text("Step-by-step guide")
                        }
                        .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                        .foregroundStyle(ApexColor.accent)
                    }
                    .accessibilityIdentifier("connector.guide")
                    CopyField("Endpoint", value: model.endpoint, toast: "Endpoint URL copied", identifier: "connector.endpoint")
                }

                VStack(alignment: .leading, spacing: Spacing.md) {
                    Text("New token").apexEyebrow()
                    FormField("Name", text: $model.name, placeholder: "e.g. Claude Desktop", identifier: "connector.name")
                        .submitLabel(.done)
                        .onSubmit { Task { await model.mint() } }
                    ApexButton(model.isMinting ? "Creating…" : "Create token", isLoading: model.isMinting) { Task { await model.mint() } }
                        .disabled(!model.canMint)
                        .accessibilityIdentifier("connector.create")
                }

                if !model.connections.isEmpty {
                    SettingsSection("Connected apps") {
                        ForEach(Array(model.connections.enumerated()), id: \.element.id) { index, connection in
                            if index > 0 { SettingsDivider() }
                            line(connection.name.isEmpty ? "Connected app" : connection.name, detail: model.connectionLine(connection), identifier: "connector.app.\(connection.clientId)") {
                                disconnecting = connection
                            }
                        }
                    }
                }

                if model.isLoaded {
                    SettingsSection("Access tokens", footer: model.activeTokens.isEmpty ? "No tokens yet. Claude and ChatGPT sign in without one; Claude Code and other tools paste one." : nil) {
                        if model.activeTokens.isEmpty {
                            Text("None")
                                .apexBody()
                                .padding(.horizontal, Spacing.lg)
                                .frame(minHeight: 48, alignment: .leading)
                        }
                        ForEach(Array(model.activeTokens.enumerated()), id: \.element.id) { index, token in
                            if index > 0 { SettingsDivider() }
                            line(token.name, detail: model.tokenLine(token), identifier: "connector.token.\(token.name)") {
                                revoking = token
                            }
                        }
                    }
                } else {
                    ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity)
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("AI connector")
        .task { await model.load() }
        .sheet(item: $model.minted) { minted in
            TokenRevealSheet(token: minted.token) { model.minted = nil }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
                .presentationBackground(ApexColor.bgSurface)
        }
        .confirmationDialog("Revoke \(revoking?.name ?? "")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("Revoke token", role: .destructive) {
                if let token = revoking { Task { await model.revoke(token) } }
                revoking = nil
            }
            .accessibilityIdentifier("connector.revoke.confirm")
        } message: {
            Text("Anything using it stops working at once.")
        }
        .confirmationDialog("Disconnect \(disconnecting?.name ?? "app")?", isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }), titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) {
                if let connection = disconnecting { Task { await model.disconnect(connection) } }
                disconnecting = nil
            }
        } message: {
            Text("It is cut off immediately and completely; it can set itself up again.")
        }
    }

    private func line(_ title: String, detail: String, identifier: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(1)
                Text(detail)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: onRemove) {
                ApexIcon.close.image
                    .font(.system(size: 14))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(title)")
            .accessibilityIdentifier("\(identifier).remove")
        }
        .padding(.leading, Spacing.lg)
        .padding(.trailing, Spacing.xs)
        .frame(minHeight: 52)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// The plaintext token, shown exactly once. Closing it is the last time it exists on this side.
public struct TokenRevealSheet: View {
    private let token: String
    private let onDone: () -> Void

    public init(token: String, onDone: @escaping () -> Void) {
        self.token = token
        self.onDone = onDone
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            SheetHeader(title: "Your new token", onClose: onDone)
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Text("Copy this token now — it won't be shown again. Send it as `Authorization: Bearer <token>`.")
                    .apexBody()
                    .fixedSize(horizontal: false, vertical: true)
                CopyField(value: token, toast: "Token copied", identifier: "token.reveal")
                ApexButton("Done", action: onDone)
                    .accessibilityIdentifier("token.reveal.done")
                Spacer()
            }
            .padding(.horizontal, Spacing.screen)
        }
        .background(ApexColor.bgSurface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("token.reveal.sheet")
    }
}
