import ApexCore
import ApexUI
import SwiftUI

/// Updated Terms or Privacy are published and this account has not accepted
/// them (W16 MT) — `TermsGate.tsx` on the phone. It stands in place of the
/// tabs rather than over them: every gated request would 403 behind it, so a
/// dismissible sheet would only buy a screen of failures. The ways out are
/// accepting and signing out.
public struct TermsUpdateView: View {
    private let status: TermsStatus
    private let email: String?
    private let termsURL: URL
    private let privacyURL: URL
    private let onAccept: () async -> String?
    private let onSignOut: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var accepted = false
    @State private var isWorking = false
    @State private var problem: String?

    public init(
        status: TermsStatus, email: String?, termsURL: URL, privacyURL: URL,
        onAccept: @escaping () async -> String?, onSignOut: @escaping () -> Void
    ) {
        self.status = status
        self.email = email
        self.termsURL = termsURL
        self.privacyURL = privacyURL
        self.onAccept = onAccept
        self.onSignOut = onSignOut
    }

    private var isReturning: Bool { status.accepted != nil }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                Spacer(minLength: Spacing.xl)
                Wordmark().frame(maxWidth: .infinity)

                Text(isReturning ? "Our terms have changed" : "Before you start")
                    .font(.apex(.display, size: TypeScale.xl, weight: .semibold, relativeTo: .title2))
                    .foregroundStyle(ApexColor.textPrimary)
                    .accessibilityIdentifier("terms.title")

                Text(isReturning
                     ? "We have published updated documents. Please read them and accept to keep using Apex."
                     : "Apex needs your agreement to two short documents before it can load your training data.")
                    .apexBody()

                if let previous = status.accepted, let terms = previous.termsVersion, let privacy = previous.privacyVersion {
                    Text("You previously accepted \(terms) and \(privacy)\(Self.onDate(previous.acceptedAt)). That record is kept; accepting now adds a new one.")
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textMuted)
                }

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Link(destination: termsURL) { documentRow("Terms of Service", version: status.termsVersion) }
                        .accessibilityIdentifier("terms.link.terms")
                    Link(destination: privacyURL) { documentRow("Privacy Policy", version: status.privacyVersion) }
                        .accessibilityIdentifier("terms.link.privacy")
                }

                Toggle(isOn: $accepted) {
                    Text("I accept the Terms of Service and Privacy Policy.")
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textSecondary)
                }
                .tint(ApexColor.accent)
                .disabled(isWorking)
                .accessibilityIdentifier("terms.accept.toggle")

                if let problem {
                    Text(problem)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.dangerText)
                        .accessibilityIdentifier("terms.problem")
                }

                ApexButton(isWorking ? "Recording…" : "Accept and continue", isLoading: isWorking) { submit() }
                    .disabled(!accepted || isWorking)
                    .accessibilityIdentifier("terms.accept")

                Button(email.map { "Sign out (\($0))" } ?? "Sign out", action: onSignOut)
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .accessibilityIdentifier("terms.signout")

                Spacer(minLength: Spacing.xl)
            }
            .padding(.horizontal, Spacing.xl)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(ApexColor.bgPrimary)
        .accessibilityIdentifier("terms.update")
    }

    /// Title and version side by side; stacked at the accessibility sizes,
    /// where side by side breaks "Service" mid-word.
    private func documentRow(_ title: String, version: String?) -> some View {
        HStack {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
                : AnyLayout(HStackLayout(spacing: Spacing.sm))
            layout {
                Text(title)
                    .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                    .foregroundStyle(ApexColor.accent)
                    .multilineTextAlignment(.leading)
                if let version {
                    Text(version)
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right").foregroundStyle(ApexColor.textMuted)
        }
        .frame(minHeight: 44)
    }

    private func submit() {
        guard accepted, !isWorking else { return }
        problem = nil
        isWorking = true
        Task {
            problem = await onAccept()
            isWorking = false
        }
    }

    /// " on Aug 29, 2026", or nothing when the stamp does not parse.
    static func onDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        return " on " + date.formatted(date: .abbreviated, time: .omitted)
    }
}
