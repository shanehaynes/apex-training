import SwiftUI

/// Title plus a close affordance, for sheets presented with a drag indicator.
public struct SheetHeader: View {
    private let title: String
    private let onClose: () -> Void

    public init(title: String, onClose: @escaping () -> Void) {
        self.title = title
        self.onClose = onClose
    }

    public var body: some View {
        HStack {
            Text(title).apexTitle()
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.sm)
    }
}
