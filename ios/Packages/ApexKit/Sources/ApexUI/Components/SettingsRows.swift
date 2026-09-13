import SwiftUI

/// The You tab's grouped sections (U24): an eyebrow over a card of 44pt rows
/// on the surface colour, the native Settings shape drawn in the house
/// palette rather than `List(.insetGrouped)`, whose chrome cannot be recoloured
/// far enough to sit on the warm charcoal.
public struct SettingsSection<Content: View>: View {
    private let title: String?
    private let footer: String?
    private let content: Content

    public init(_ title: String? = nil, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let title {
                Text(title).apexEyebrow().padding(.horizontal, Spacing.xs)
            }
            VStack(spacing: 0) {
                content
            }
            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
            if let footer {
                Text(footer)
                    .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Spacing.xs)
            }
        }
    }
}

/// One row: a title, an optional value on the trailing side, an optional
/// chevron. Rows are separated by a hairline inset from the leading edge.
public struct SettingsRow<Trailing: View>: View {
    public enum Tone: Sendable { case normal, destructive }

    private let title: String
    private let symbol: String?
    private let tone: Tone
    private let showsChevron: Bool
    private let trailing: Trailing

    public init(
        _ title: String, symbol: String? = nil, tone: Tone = .normal, showsChevron: Bool = true,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.symbol = symbol
        self.tone = tone
        self.showsChevron = showsChevron
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: Spacing.md) {
            if let symbol {
                Image(systemName: symbol)
                    .fontWeight(.light)
                    .font(.system(size: 16))
                    .foregroundStyle(tone == .destructive ? ApexPalette.dangerText : ApexColor.textSecondary)
                    .frame(width: 22)
            }
            Text(title)
                .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                .foregroundStyle(tone == .destructive ? ApexPalette.dangerText : ApexColor.textPrimary)
                .lineLimit(1)
                // The title is the row's identity; a long value truncates first.
                .layoutPriority(1)
            Spacer(minLength: Spacing.sm)
            trailing
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
            if showsChevron {
                ApexIcon.chevronRight.image
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ApexColor.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .frame(minHeight: 48)
        .contentShape(.rect)
    }
}

extension SettingsRow where Trailing == Text {
    /// The common case: a title and a muted value.
    public init(_ title: String, value: String? = nil, symbol: String? = nil, tone: Tone = .normal, showsChevron: Bool = true) {
        self.init(title, symbol: symbol, tone: tone, showsChevron: showsChevron) { Text(value ?? "") }
    }
}

/// A row that pushes a route.
public struct SettingsLink<Route: Hashable, Trailing: View>: View {
    private let route: Route
    private let row: SettingsRow<Trailing>
    private let identifier: String?

    public init(_ title: String, value: String? = nil, symbol: String? = nil, tone: SettingsRow<Trailing>.Tone = .normal, to route: Route, identifier: String? = nil) where Trailing == Text {
        self.route = route
        self.row = SettingsRow(title, value: value, symbol: symbol, tone: tone)
        self.identifier = identifier
    }

    public var body: some View {
        NavigationLink(value: route) { row }
            .buttonStyle(SettingsRowButtonStyle())
            .accessibilityIdentifier(identifier ?? "")
    }
}

/// A row that runs an action (a sheet, a copy, a sign-out).
public struct SettingsButton<Trailing: View>: View {
    private let row: SettingsRow<Trailing>
    private let action: () -> Void
    private let identifier: String?

    public init(
        _ title: String, value: String? = nil, symbol: String? = nil, tone: SettingsRow<Trailing>.Tone = .normal,
        showsChevron: Bool = true, identifier: String? = nil, action: @escaping () -> Void
    ) where Trailing == Text {
        self.row = SettingsRow(title, value: value, symbol: symbol, tone: tone, showsChevron: showsChevron)
        self.action = action
        self.identifier = identifier
    }

    public var body: some View {
        Button(action: action) { row }
            .buttonStyle(SettingsRowButtonStyle())
            .accessibilityIdentifier(identifier ?? "")
    }
}

/// A row with a native toggle.
public struct SettingsToggle: View {
    private let title: String
    private let symbol: String?
    @Binding private var isOn: Bool
    private let identifier: String?

    public init(_ title: String, symbol: String? = nil, isOn: Binding<Bool>, identifier: String? = nil) {
        self.title = title
        self.symbol = symbol
        self._isOn = isOn
        self.identifier = identifier
    }

    public var body: some View {
        SettingsRow(title, symbol: symbol, showsChevron: false) {
            Toggle("", isOn: $isOn)
                .labelsHidden()
                .tint(ApexPalette.positive)
                .accessibilityIdentifier(identifier ?? "")
        }
    }
}

/// The hairline between rows, inset like the native one.
public struct SettingsDivider: View {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(ApexColor.borderSubtle)
            .frame(height: 1)
            .padding(.leading, Spacing.lg)
    }
}

/// Pressed rows tint like the native list cell; shared with rows other modules draw.
public struct SettingsRowButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? ApexColor.bgElevated : .clear)
    }
}

/// A read-only value with a copy affordance — the web's `.profile-feed` row
/// (the calendar feed, the MCP endpoint, a fresh token). Copy writes the
/// pasteboard and toasts; the value is shown mono, middle-truncated.
public struct CopyField: View {
    private let label: String?
    private let value: String
    private let toast: String
    private let identifier: String?

    public init(_ label: String? = nil, value: String, toast: String = "Copied", identifier: String? = nil) {
        self.label = label
        self.value = value
        self.toast = toast
        self.identifier = identifier
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let label { Text(label).apexFieldLabel() }
            HStack(spacing: Spacing.sm) {
                Text(value)
                    .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier(identifier.map { "\($0).value" } ?? "")
                Spacer(minLength: 0)
                Button {
                    UIPasteboard.general.string = value
                    ToastBus.shared.post(toast, level: .success)
                } label: {
                    ApexIcon.copy.image
                        .font(.system(size: 15))
                        .foregroundStyle(ApexColor.textPrimary)
                        .frame(width: 36, height: 36)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy")
                .accessibilityIdentifier(identifier.map { "\($0).copy" } ?? "")
            }
            .apexFieldChrome()
        }
    }
}
