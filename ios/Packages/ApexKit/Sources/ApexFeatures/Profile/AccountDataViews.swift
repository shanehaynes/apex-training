import ApexCore
import ApexUI
import SwiftUI

/// Terms, Privacy, the acceptance on record, the build.
public struct AboutView: View {
    private let model: YouModel

    public init(model: YouModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Wordmark()
                    Text("Reach new heights.")
                        .apexBody()
                    if !model.services.versionLabel.isEmpty {
                        Text("Version \(model.services.versionLabel)")
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                            .accessibilityIdentifier("you.about.version")
                    }
                }
                SettingsSection("Legal", footer: acceptanceLine) {
                    Link(destination: model.services.termsURL) {
                        SettingsRow("Terms of Service", symbol: ApexIcon.shield.systemName, showsChevron: false) {
                            ApexIcon.externalLink.image.font(.system(size: 14))
                        }
                    }
                    .buttonStyle(SettingsRowButtonStyle())
                    .accessibilityIdentifier("you.about.terms")
                    SettingsDivider()
                    Link(destination: model.services.privacyURL) {
                        SettingsRow("Privacy Policy", symbol: ApexIcon.lock.systemName, showsChevron: false) {
                            ApexIcon.externalLink.image.font(.system(size: 14))
                        }
                    }
                    .buttonStyle(SettingsRowButtonStyle())
                    .accessibilityIdentifier("you.about.privacy")
                }
                Hint("Your data can be exported as JSON from the web app's profile. Deleting the account is under Data on the previous screen.")
            }
            .padding(Spacing.screen)
        }
        .youScreen("About")
    }

    private var acceptanceLine: String? {
        guard let accepted = model.profile?.termsAccepted, let version = accepted.termsVersion else { return nil }
        let when = IsoDate.parse(accepted.acceptedAt).map { date in
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = model.services.timeZone
            f.dateStyle = .medium
            return f.string(from: date)
        }
        return "You accepted \(version)" + (when.map { " on \($0)" } ?? "") + "."
    }
}

/// App Store 5.1.1(v). Transcribing the address is a deliberate act, and it
/// also proves they know which account they are standing in (`AccountData.tsx`).
public struct DeleteAccountView: View {
    private let model: YouModel
    @State private var typed = ""
    @State private var error: String?
    @State private var isDeleting = false

    public init(model: YouModel) {
        self.model = model
    }

    private var email: String { model.email ?? "" }
    private var matches: Bool { !email.isEmpty && typed.trimmingCharacters(in: .whitespaces) == email }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Deleting your account removes your schedule, logs, meals, imported watch activities, and review history permanently. It cannot be undone, and we cannot recover it for you. Export a copy from the web app first if you want one.")
                FormField("Type \(email) to confirm", text: $typed, placeholder: email, keyboard: .emailAddress, identifier: "you.delete.field")
                    .textInputAutocapitalization(.never)
                    .disabled(isDeleting)
                if let error { InlineError(error, identifier: "you.delete.error") }
                ApexButton(isDeleting ? "Deleting…" : "Delete permanently", kind: .destructive, isLoading: isDeleting) {
                    Task { await run() }
                }
                .disabled(!matches)
                .opacity(matches ? 1 : 0.5)
                .accessibilityIdentifier("you.delete.confirm")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Delete account")
    }

    private func run() async {
        isDeleting = true
        error = await model.deleteAccount()
        isDeleting = false
    }
}
