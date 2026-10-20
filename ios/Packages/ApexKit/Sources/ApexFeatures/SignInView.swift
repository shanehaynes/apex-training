import ApexUI
import SwiftUI

/// Open sign-up's half of the screen (docs/specs/open-signup.md M3): where
/// the human check lives, the documents the terms toggle names, and the call.
public struct SignUpOptions {
    public let checkURL: URL
    public let termsURL: URL
    public let privacyURL: URL
    /// (email, Turnstile token, 18+ attested) → nil on success, else the sentence to show.
    public let submit: (String, String, Bool) async -> String?

    public init(checkURL: URL, termsURL: URL, privacyURL: URL, submit: @escaping (String, String, Bool) async -> String?) {
        self.checkURL = checkURL
        self.termsURL = termsURL
        self.privacyURL = privacyURL
        self.submit = submit
    }
}

/// Email + password, with the content types AutoFill and Face ID need. With
/// `signUp` set, a Create account mode sits beside it: email, the terms and
/// 18+ toggles, a Turnstile check, then an invite by email — the password is
/// chosen on the set-password screen the invite opens. Without it, sign-up is
/// invite-only, so the screen says so and gives a way forward instead of a
/// dead end (App Store guideline 5.1.1 wants exactly this).
public struct SignInView: View {
    private let inviteContact: URL?
    private let signUp: SignUpOptions?
    private let onSignIn: (String, String) async -> String?
    private let onForgotPassword: (String) async -> String?

    private enum Mode: Hashable { case signIn, create }
    @State private var mode: Mode = .signIn
    @State private var accepted = false
    @State private var ageConfirmed = false
    @State private var showingCheck = false

    @State private var email = ""
    @State private var password = ""
    @State private var isWorking = false
    @State private var problem: String?
    @State private var notice: String?
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    /// `inviteContact` is where "Request an invite" goes (a `mailto:`, from the
    /// build configuration); nil states invite-only without offering a link.
    public init(
        inviteContact: URL? = nil,
        signUp: SignUpOptions? = nil,
        onSignIn: @escaping (String, String) async -> String?,
        onForgotPassword: @escaping (String) async -> String?
    ) {
        self.inviteContact = inviteContact
        self.signUp = signUp
        self.onSignIn = onSignIn
        self.onForgotPassword = onForgotPassword
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: Spacing.xl) {
                Spacer(minLength: Spacing.xxl)
                Wordmark()

                if signUp != nil {
                    Picker("Mode", selection: $mode) {
                        Text("Sign in").tag(Mode.signIn)
                        Text("Create account").tag(Mode.create)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("signin.mode")
                    .onChange(of: mode) {
                        // Consent is an act per visit to the form, never carried over.
                        accepted = false
                        ageConfirmed = false
                        problem = nil
                        notice = nil
                    }
                }

                if mode == .create, let signUp {
                    createAccount(signUp)
                } else {
                    signInForm
                }

                if signUp == nil {
                    inviteOnlyFooter
                }

                Spacer(minLength: Spacing.xxl)
            }
            .padding(.horizontal, Spacing.xl)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(ApexColor.bgPrimary)
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $showingCheck) {
            if let signUp {
                TurnstileCheckView(url: signUp.checkURL) { token in
                    create(with: token, signUp)
                }
            }
        }
    }

    @ViewBuilder
    private var signInForm: some View {
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
                // Footnote weight, not the button's: the user came to sign in.
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .footnote))
                .foregroundStyle(ApexColor.textMuted)
                .frame(minHeight: 44)

    }

    @ViewBuilder
    private var inviteOnlyFooter: some View {
                VStack(spacing: Spacing.xs) {
                    Text("Apex is invite-only.")
                        .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .multilineTextAlignment(.center)
                    if let inviteContact {
                        Link("Request an invite", destination: inviteContact)
                            .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textSecondary)
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("signin.invite")
                    }
                }
                .padding(.top, Spacing.lg)
    }

    @ViewBuilder
    private func createAccount(_ signUp: SignUpOptions) -> some View {
        Text("We'll email you a link to choose your password.")
            .apexBody()
            .multilineTextAlignment(.center)

        field("Email", text: $email, field: .email)
            .textContentType(.username)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)

        VStack(alignment: .leading, spacing: Spacing.sm) {
            Toggle(isOn: $accepted) {
                Text("I accept the Terms of Service and Privacy Policy.")
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
            }
            .tint(ApexColor.accent)
            .accessibilityIdentifier("signup.terms")
            // Beside the toggle, not in a footer: the documents being agreed to
            // must be reachable at the moment of assent.
            HStack(spacing: Spacing.md) {
                Link("Terms of Service", destination: signUp.termsURL)
                Link("Privacy Policy", destination: signUp.privacyURL)
            }
            .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
            .foregroundStyle(ApexColor.textSecondary)

            Toggle(isOn: $ageConfirmed) {
                Text("I am 18 or older (or the age of majority where I live).")
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
            }
            .tint(ApexColor.accent)
            .accessibilityIdentifier("signup.age")
        }

        if let problem {
            Text(problem)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexPalette.dangerText)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("signup.problem")
        }
        if let notice {
            Text(notice)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexPalette.positive)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("signup.notice")
        }

        ApexButton("Create account", isLoading: isWorking) {
            focus = nil
            problem = nil
            notice = nil
            showingCheck = true
        }
        .disabled(!looksLikeEmail || !accepted || !ageConfirmed || isWorking)
        .accessibilityIdentifier("signup.submit")
    }

    private var looksLikeEmail: Bool {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        return trimmed.contains("@") && trimmed.contains(".")
    }

    private func create(with token: String, _ signUp: SignUpOptions) {
        guard !isWorking else { return }
        isWorking = true
        let address = email.trimmingCharacters(in: .whitespaces)
        Task {
            if let message = await signUp.submit(address, token, ageConfirmed) {
                problem = message
            } else {
                notice = "Check \(address) for a link to choose your password."
                accepted = false
                ageConfirmed = false
            }
            isWorking = false
        }
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
