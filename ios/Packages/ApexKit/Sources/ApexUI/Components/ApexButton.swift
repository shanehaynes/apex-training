import SwiftUI

/// The two button shapes the web uses: an accent-filled CTA and a bordered
/// secondary. 32pt visual height, 44pt hit area (design-spec §5).
public struct ApexButton: View {
    public enum Kind: Sendable { case primary, secondary, destructive }

    private let title: String
    private let kind: Kind
    private let isLoading: Bool
    private let action: () -> Void

    public init(
        _ title: String,
        kind: Kind = .primary,
        isLoading: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.kind = kind
        self.isLoading = isLoading
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            ZStack {
                Text(title).opacity(isLoading ? 0 : 1)
                if isLoading {
                    ProgressView().controlSize(.small).tint(foreground)
                }
            }
            .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(background, in: .rect(cornerRadius: Radius.md))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md)
                    .strokeBorder(border, lineWidth: kind == .secondary ? 1 : 0)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }

    private var foreground: Color {
        switch kind {
        case .primary: ApexColor.bgPrimary
        case .secondary: ApexColor.textPrimary
        case .destructive: ApexColor.textPrimary
        }
    }

    private var background: Color {
        switch kind {
        case .primary: ApexColor.accent
        case .secondary: ApexColor.bgSurface
        case .destructive: ApexPalette.destructive
        }
    }

    private var border: Color {
        kind == .secondary ? ApexColor.borderSubtle : .clear
    }
}
