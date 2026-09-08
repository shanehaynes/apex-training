import SwiftUI

/// The tracker's sticky bottom bar (`.tracker-confirm` on the web): one line of
/// copy and two actions. Lives in a `safeAreaInset(edge: .bottom)` so the
/// keyboard lifts it instead of covering it (U3).
public struct ConfirmBar: View {
    public struct Action {
        public let title: String
        public let action: () -> Void
        public init(_ title: String, action: @escaping () -> Void) {
            self.title = title
            self.action = action
        }
    }

    private let message: String
    private let primary: Action
    private let secondary: Action?
    private let isDestructive: Bool
    private let isBusy: Bool

    public init(message: String, primary: Action, secondary: Action? = nil, isDestructive: Bool = false, isBusy: Bool = false) {
        self.message = message
        self.primary = primary
        self.secondary = secondary
        self.isDestructive = isDestructive
        self.isBusy = isBusy
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(message)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Spacing.sm) {
                if let secondary {
                    ApexButton(secondary.title, kind: .secondary, action: secondary.action)
                        .disabled(isBusy)
                }
                ApexButton(primary.title, kind: isDestructive ? .destructive : .primary, isLoading: isBusy, action: primary.action)
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.md)
        .padding(.bottom, Spacing.md)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgElevated)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityIdentifier("tracker.confirm")
    }
}
