import ApexUI
import SwiftUI

/// Set-a-password, reached with a session already in place: an invite (first
/// sign-in) or a password-recovery link. Mirrors `SetPasswordView.tsx`.
/// `.newPassword` content types let the password manager generate and save
/// the credential, which is what makes Face ID sign-in work later.
public struct SetPasswordView: View {
    private let email: String?
    private let needsTerms: Bool
    private let onSubmit: (String) async -> String?
    private let onCancel: () -> Void

    @State private var password = ""
    @State private var confirm = ""
    @State private var accepted = false
    @State private var isWorking = false
    @State private var problem: String?
    @FocusState private var focus: Field?

    private enum Field { case password, confirm }

    public init(
        email: String?,
        needsTerms: Bool,
        onSubmit: @escaping (String) async -> String?,
        onCancel: @escaping () -> Void
    ) {
        self.email = email
        self.needsTerms = needsTerms
        self.onSubmit = onSubmit
        self.onCancel = onCancel
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: Spacing.xl) {
                Spacer(minLength: Spacing.xxl)
                Wordmark()

                Text("Set a password for \(email ?? "your account").")
                    .apexBody()
                    .multilineTextAlignment(.center)

                VStack(spacing: Spacing.md) {
                    // A hidden username gives the password manager the account
                    // identity to store alongside the generated password.
                    TextField("", text: .constant(email ?? ""))
                        .textContentType(.username)
                        .frame(width: 0, height: 0)
                        .opacity(0)
                        .accessibilityHidden(true)

                    field("New password", text: $password, field: .password)
                        .submitLabel(.next)
                        .onSubmit { focus = .confirm }
                    field("Confirm password", text: $confirm, field: .confirm)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                }

                if needsTerms {
                    Toggle(isOn: $accepted) {
                        Text("I accept the Terms of Service and Privacy Policy.")
                            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                            .foregroundStyle(ApexColor.textSecondary)
                    }
                    .tint(ApexColor.accent)
                    .accessibilityIdentifier("setpassword.terms")
                }

                if let problem {
                    Text(problem)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.dangerText)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("setpassword.problem")
                }

                ApexButton("Set password", isLoading: isWorking) { submit() }
                    .disabled(password.isEmpty || confirm.isEmpty || (needsTerms && !accepted))
                    .accessibilityIdentifier("setpassword.submit")

                Button("Cancel and sign out", action: onCancel)
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .frame(minHeight: 44)

                Spacer(minLength: Spacing.xxl)
            }
            .padding(.horizontal, Spacing.xl)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(ApexColor.bgPrimary)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("setpassword")
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, field: Field) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            SecureField("", text: text)
                .textContentType(.newPassword)
                .focused($focus, equals: field)
                .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 44)
                .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.md)
                        .strokeBorder(focus == field ? ApexColor.accent : ApexColor.borderSubtle, lineWidth: 1)
                )
                .accessibilityIdentifier(field == .password ? "setpassword.new" : "setpassword.confirm")
        }
    }

    private func submit() {
        guard !isWorking else { return }
        problem = nil
        if needsTerms, !accepted {
            problem = "Please accept the Terms of Service and Privacy Policy to continue."
            return
        }
        if password.count < 8 {
            problem = "Password must be at least 8 characters."
            return
        }
        if password != confirm {
            problem = "Passwords do not match."
            return
        }
        focus = nil
        isWorking = true
        Task {
            problem = await onSubmit(password)
            isWorking = false
        }
    }
}
