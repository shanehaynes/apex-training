import ApexUI
import SwiftUI

/// Email + password, with the content types AutoFill and Face ID need. Sign-up
/// is invite-only, so the screen says so and gives a way forward instead of a
/// dead end (App Store guideline 5.1.1 wants exactly this).
public struct SignInView: View {
    private let onSignIn: (String, String) async -> String?
    private let onForgotPassword: (String) async -> String?

    @State private var email = ""
    @State private var password = ""
    @State private var isWorking = false
    @State private var problem: String?
    @State private var notice: String?
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    public init(
        onSignIn: @escaping (String, String) async -> String?,
        onForgotPassword: @escaping (String) async -> String?
    ) {
        self.onSignIn = onSignIn
        self.onForgotPassword = onForgotPassword
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: Spacing.xl) {
                Spacer(minLength: Spacing.xxl)
                Wordmark()

                VStack(spacing: Spacing.md) {
                    field("Email", text: $email, field: .email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focus = .password }

                    field("Password", text: $password, field: .password, secure: true)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                }

                if let problem {
                    Text(problem)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.dangerText)
                        .multilineTextAlignment(.center)
                }
                if let notice {
                    Text(notice)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.positive)
                        .multilineTextAlignment(.center)
                }

                ApexButton("Sign in", isLoading: isWorking) { submit() }
                    .disabled(email.isEmpty || password.isEmpty)

                Button("Forgot password?") {
                    Task {
                        problem = nil
                        notice = nil
                        if let message = await onForgotPassword(email) {
                            problem = message
                        } else {
                            notice = "Check your email for a reset link."
                        }
                    }
                }
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textSecondary)
                .frame(minHeight: 44)

                Text("Apex is invite-only. If you need an account, ask Shane for an invite.")
                    .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .multilineTextAlignment(.center)
                    .padding(.top, Spacing.lg)

                Spacer(minLength: Spacing.xxl)
            }
            .padding(.horizontal, Spacing.xl)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(ApexColor.bgPrimary)
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private func field(
        _ label: String,
        text: Binding<String>,
        field: Field,
        secure: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            Group {
                if secure {
                    SecureField("", text: text)
                } else {
                    TextField("", text: text)
                }
            }
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
            .accessibilityIdentifier(secure ? "signin.password" : "signin.email")
        }
    }

    private func submit() {
        guard !email.isEmpty, !password.isEmpty, !isWorking else { return }
        focus = nil
        isWorking = true
        Task {
            problem = nil
            notice = nil
            problem = await onSignIn(email.trimmingCharacters(in: .whitespaces), password)
            isWorking = false
        }
    }
}
