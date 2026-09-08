import ApexCore
import ApexUI
import SwiftUI

/// Save, replace or remove the user's Anthropic API key — the You › AI Coach
/// key section (W11), pulled forward so the coach's 402 state is one tap from
/// a fix (U31, D-025). The server validates the key against Anthropic and
/// answers 400 with Anthropic's own message; the raw key is never echoed back.
public struct AnthropicKeyView: View {
    private let client: ApexClient
    private let hasKey: Bool
    private let last4: String?
    private let onChanged: (ProfileResponse?) -> Void

    @State private var key = ""
    @State private var error: String?
    @State private var isSaving = false
    @Environment(\.dismiss) private var dismiss

    public init(client: ApexClient, hasKey: Bool, last4: String?, onChanged: @escaping (ProfileResponse?) -> Void) {
        self.client = client
        self.hasKey = hasKey
        self.last4 = last4
        self.onChanged = onChanged
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            SheetHeader(title: "Anthropic API key") { dismiss() }
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Text("The coach runs on your own key, billed to your Anthropic account. It is stored encrypted on the server and never shown again.")
                    .apexBody()
                    .fixedSize(horizontal: false, vertical: true)

                if hasKey {
                    HStack(spacing: Spacing.sm) {
                        ApexIcon.key.image.foregroundStyle(ApexColor.textMuted)
                        Text("Key saved · ••••\(last4 ?? "")")
                            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                            .foregroundStyle(ApexColor.textPrimary)
                    }
                    .accessibilityIdentifier("key.saved")
                }

                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(hasKey ? "Replace key" : "Key").apexFieldLabel()
                    SecureField("sk-ant-…", text: $key)
                        .font(.apex(.mono, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, Spacing.md)
                        .frame(minHeight: 44)
                        .background(ApexColor.bgPrimary, in: .rect(cornerRadius: Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                        .accessibilityIdentifier("key.field")
                }

                if let error {
                    Text(error)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.dangerText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("key.error")
                }

                ApexButton(hasKey ? "Replace key" : "Save key", isLoading: isSaving) { Task { await save() } }
                    .disabled(!key.hasPrefix("sk-ant-") || key.count < 20)
                    .accessibilityIdentifier("key.save")

                if hasKey {
                    ApexButton("Remove key", kind: .destructive, isLoading: isSaving) { Task { await remove() } }
                        .accessibilityIdentifier("key.remove")
                }
                Spacer()
            }
            .padding(.horizontal, Spacing.screen)
        }
        .background(ApexColor.bgSurface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("key.sheet")
    }

    private func save() async {
        await submit(.setAnthropicKey(key.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    private func remove() async {
        await submit(.setAnthropicKey(nil))
    }

    private func submit(_ endpoint: Endpoint) async {
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let data = try await client.data(for: endpoint)
            let status = try? JSONDecoder().decode(KeyStatus.self, from: data)
            let profile = status.map {
                ProfileResponse(hasAnthropicKey: $0.hasAnthropicKey ?? false, anthropicKeyLast4: $0.anthropicKeyLast4,
                                termsAccepted: nil, termsCurrent: true)
            }
            onChanged(profile)
            dismiss()
        } catch let apiError as APIError {
            switch apiError {
            case .server(_, let message?) where !message.isEmpty: error = message
            case .network: error = "You're offline — try again when connected."
            default: error = apiError.description
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// `PATCH /api/profile` answers `{ ok, hasAnthropicKey, anthropicKeyLast4 }`.
    private struct KeyStatus: Decodable {
        let ok: Bool
        let hasAnthropicKey: Bool?
        let anthropicKeyLast4: String?
    }
}
