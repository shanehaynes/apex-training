import ApexCore
import ApexUI
import SwiftUI

/// Local conversations (D-013): newest first, tap to resume, swipe to delete,
/// and a New button. Titles are the first line of the first message.
public struct ConversationListView: View {
    private let model: CoachModel

    public init(model: CoachModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Conversations") { model.showConversations = false }
            Button { model.newConversation() } label: {
                HStack(spacing: Spacing.sm) {
                    ApexIcon.newChat.image
                    Text("New conversation")
                }
                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, Spacing.screen)
            }
            .buttonStyle(.plain)
            .disabled(model.isStreaming || model.pending != nil)
            .accessibilityIdentifier("coach.conversations.new")

            if model.conversations.isEmpty {
                EmptyState(eyebrow: "Nothing yet", message: "Your conversations with the coach stay on this phone.", symbol: ApexIcon.chat.systemName)
                    .background(ApexColor.bgSurface)
            } else {
                List {
                    ForEach(model.conversations) { conversation in
                        Button { model.resume(conversation.id) } label: {
                            VStack(alignment: .leading, spacing: Spacing.xs) {
                                Text(conversation.title ?? "Untitled")
                                    .font(.apex(.display, size: TypeScale.base, weight: conversation.id == model.conversation?.id ? .semibold : .regular, relativeTo: .body))
                                    .foregroundStyle(ApexColor.textPrimary)
                                    .lineLimit(2)
                                Text(conversation.updatedAt, format: .relative(presentation: .named))
                                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                    .foregroundStyle(ApexColor.textMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, Spacing.xs)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(ApexColor.bgSurface)
                        .listRowSeparatorTint(ApexColor.borderSubtle)
                        .accessibilityIdentifier("coach.conversations.row")
                    }
                    .onDelete { offsets in
                        for offset in offsets { model.delete(model.conversations[offset].id) }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(ApexColor.bgSurface)
            }
        }
        .background(ApexColor.bgSurface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach.conversations.list")
    }
}
