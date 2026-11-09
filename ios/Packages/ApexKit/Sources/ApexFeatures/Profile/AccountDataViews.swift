import ApexCore
import ApexUI
import SwiftUI
import UniformTypeIdentifiers

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
                Hint("Exporting your data and deleting the account are under Data on the previous screen.")
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
                Hint("Deleting your account removes your schedule, logs, meals, imported watch activities, and review history permanently. It cannot be undone, and we cannot recover it for you. Export a copy first if you want one.")
                // `COROS_DELETE_NOTICE` (corosRevocation.ts): the grant lives at
                // COROS, and no account is left afterwards to tell.
                Hint("If you connected a COROS account, deletion removes Apex’s copy of your watch tokens, but it cannot withdraw the permission you granted at COROS — remove Apex from your connected apps in the COROS app as well.")
                FormField("Type \(email) to confirm", text: $typed, placeholder: email, keyboard: .emailAddress, identifier: "you.delete.field")
                    .textInputAutocapitalization(.never)
                    .disabled(isDeleting)
                if let error { InlineError(error, identifier: "you.delete.error") }
                ApexButton(isDeleting ? "Deleting…" : "Delete permanently", kind: .destructive, isLoading: isDeleting) {
                    Task { await run() }
                }
                .disabled(!matches || isDeleting)
                .opacity(matches ? 1 : 0.5)
                .accessibilityIdentifier("you.delete.confirm")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Delete account")
    }

    /// Success leaves the button spinning until sign-out takes the screen
    /// away: a second tap would DELETE a user who no longer exists and
    /// report a failure that is not one.
    private func run() async {
        isDeleting = true
        error = nil
        if let failure = await model.deleteAccount() {
            error = failure
            isDeleting = false
        }
    }
}

/// Export my data: `GET /api/account`, saved in Files wherever the athlete
/// picks, the way the web downloads it. One control for the You tab's Data
/// section and the terms screen, as `AccountData.tsx` is one for the web's
/// profile and its terms gate. The export stays in memory until it is saved,
/// so no copy of the account is left in the app's temporary folder.
public struct ExportDataRow: View {
    private let model: YouModel
    private let identifier: String
    @State private var isExporting = false
    @State private var document: AccountExportDocument?
    @State private var saved: String?
    @State private var error: String?

    public init(model: YouModel, identifier: String = "you.row.export") {
        self.model = model
        self.identifier = identifier
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { Task { await run() } } label: {
                SettingsRow("Export my data", showsChevron: false) {
                    if isExporting {
                        ProgressView().tint(ApexColor.textMuted)
                    } else {
                        Text("JSON")
                    }
                }
            }
            .buttonStyle(SettingsRowButtonStyle())
            .disabled(isExporting)
            .accessibilityIdentifier(identifier)
            .accessibilityValue(isExporting ? "Preparing" : "")
            if let error {
                InlineError(error, identifier: "\(identifier).error")
                    .padding(.horizontal, Spacing.lg)
                    .padding(.bottom, Spacing.md)
            } else if let saved {
                Text(saved)
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Spacing.lg)
                    .padding(.bottom, Spacing.md)
                    .accessibilityIdentifier("\(identifier).saved")
            }
        }
        // A cancel shows nothing here, and neither does a save whose result
        // Files loses (Replace, "didPickDocumentURLs: with an empty array"):
        // no public callback tells the two apart, so a line shown for one
        // would show on every cancel. D-062.
        .fileExporter(
            isPresented: Binding(get: { document != nil }, set: { if !$0 { document = nil } }),
            document: document,
            contentType: .json,
            defaultFilename: model.exportFilename
        ) { result in
            switch result {
            case .success(let url): saved = "Saved \(url.lastPathComponent)."
            case .failure(let failure):
                if (failure as? CocoaError)?.code != .userCancelled {
                    error = "The export was not saved. Try again."
                }
            }
        }
    }

    private func run() async {
        isExporting = true
        error = nil
        saved = nil
        switch await model.exportData() {
        case .ready(let data): document = AccountExportDocument(data: data)
        case .failed(let message): error = message
        }
        isExporting = false
    }
}

/// The server's export as a file for `fileExporter`: written as received,
/// never parsed, so the athlete gets exactly what the server sent.
nonisolated struct AccountExportDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
