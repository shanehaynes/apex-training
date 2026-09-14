import ApexCore
import ApexUI
import SwiftUI

/// Name: saved when the field submits or loses focus, as the web saves on blur.
public struct DisplayNameView: View {
    private let model: YouModel
    @State private var name: String
    @State private var error: String?
    @FocusState private var isFocused: Bool

    public init(model: YouModel) {
        self.model = model
        _name = State(initialValue: model.profile?.displayName ?? "")
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                FormField("Name", text: $name, placeholder: "How the coach addresses you", identifier: "you.name.field")
                    .focused($isFocused)
                    .submitLabel(.done)
                    .onSubmit { Task { await save() } }
                if let error { InlineError(error) }
                Hint("Shown on your profile and used by the coach. Up to 80 characters.")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Name")
        .onChange(of: isFocused) { _, focused in
            if !focused { Task { await save() } }
        }
        .onAppear { isFocused = true }
    }

    private func save() async {
        error = await model.saveDisplayName(name)
    }
}

/// The twenty-four avatars in a grid; a tap saves at once (`pickAvatar`).
public struct AvatarPickerView: View {
    private let model: YouModel

    public init(model: YouModel) {
        self.model = model
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: Spacing.md), count: 4)

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Pick the animal that stands for you. It sits in the header here and beside the coach on the web.")
                LazyVGrid(columns: columns, spacing: Spacing.md) {
                    ForEach(Avatars.all) { avatar in
                        let isSelected = avatar.key == Avatars.avatar(for: model.avatarKey).key
                        Button {
                            Task { await model.saveAvatar(avatar.key) }
                        } label: {
                            VStack(spacing: Spacing.xs) {
                                AvatarImage(key: avatar.key, size: 64)
                                    .overlay(Circle().strokeBorder(isSelected ? ApexPalette.positive : ApexColor.borderSubtle, lineWidth: isSelected ? 2 : 1))
                                    .overlay(alignment: .bottomTrailing) {
                                        if isSelected {
                                            ApexIcon.check.image
                                                .font(.system(size: 10, weight: .bold))
                                                .foregroundStyle(ApexColor.bgPrimary)
                                                .frame(width: 20, height: 20)
                                                .background(ApexPalette.positive, in: .circle)
                                        }
                                    }
                                Text(avatar.label)
                                    .font(.apex(.display, size: TypeScale.micro, relativeTo: .caption2))
                                    .foregroundStyle(isSelected ? ApexColor.textPrimary : ApexColor.textMuted)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.center)
                                    .frame(height: 28, alignment: .top)
                            }
                            .frame(maxWidth: .infinity)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(avatar.label)
                        .accessibilityAddTraits(isSelected ? .isSelected : [])
                        .accessibilityIdentifier("you.avatar.\(avatar.key)")
                    }
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Avatar")
    }
}

/// New password twice; the web's rules (eight characters, matching), then
/// `auth.update(user:)` on the live session.
public struct ChangePasswordView: View {
    private let model: YouModel
    @State private var password = ""
    @State private var confirm = ""
    @State private var error: String?
    @State private var isSaving = false
    @Environment(\.dismiss) private var dismiss

    public init(model: YouModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                PasswordField("New password", text: $password, identifier: "you.password.new")
                PasswordField("Confirm password", text: $confirm, identifier: "you.password.confirm")
                    .onSubmit { Task { await save() } }
                if let error { InlineError(error) }
                ApexButton("Update password", isLoading: isSaving) { Task { await save() } }
                    .disabled(password.isEmpty || confirm.isEmpty)
                    .accessibilityIdentifier("you.password.save")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Change password")
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        error = await model.changePassword(password, confirm: confirm)
        if error == nil { dismiss() }
    }
}

/// A labelled `SecureField` in the field box, wired for AutoFill's new-password
/// suggestion.
struct PasswordField: View {
    private let label: String
    @Binding private var text: String
    private let identifier: String

    init(_ label: String, text: Binding<String>, identifier: String) {
        self.label = label
        self._text = text
        self.identifier = identifier
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            SecureField("", text: $text)
                .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .textContentType(.newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .apexFieldChrome()
                .accessibilityIdentifier(identifier)
        }
    }
}
