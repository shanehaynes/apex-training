import ApexCore
import ApexUI
import SwiftUI

/// Pieces of the coach exposed for snapshot tests, which live outside this
/// module and cannot reach the internal views.
public enum CoachPreviews {
    public static func card(label: String, index: Int, total: Int, isBusy: Bool = false) -> some View {
        VStack {
            Spacer()
            ConfirmationCard(label: label, index: index, total: total, isBusy: isBusy, onConfirm: {}, onCancel: {})
        }
    }

    public static func bubble(_ message: ChatSession.DisplayMessage) -> some View {
        MessageBubble(message: message).padding(Spacing.screen)
    }

    public static func typing() -> some View { TypingIndicator().padding(Spacing.screen) }
}
