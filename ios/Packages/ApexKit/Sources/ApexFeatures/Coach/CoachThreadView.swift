import ApexCore
import ApexUI
import SwiftUI

/// The message list. Sticks to the bottom as text streams in; the keyboard
/// dismisses on a downward drag.
struct CoachThreadView: View {
    let model: CoachModel

    private let bottomID = "coach.bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Spacing.md) {
                    ForEach(model.messages) { message in
                        MessageBubble(message: message)
                    }
                    if model.isStreaming {
                        if model.partial.isEmpty {
                            TypingIndicator()
                                .accessibilityIdentifier("coach.typing")
                        } else {
                            StreamingBubble(text: model.partial)
                        }
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                .padding(.horizontal, Spacing.screen)
                .padding(.top, Spacing.md)
                .padding(.bottom, Spacing.sm)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: model.partial) { _, _ in scrollToBottom(proxy, animated: false) }
            .onChange(of: model.state) { _, _ in scrollToBottom(proxy) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach.thread")
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(Motion.spring) { proxy.scrollTo(bottomID, anchor: .bottom) }
        } else {
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
    }
}

/// One row of the thread. User turns sit right in the web's navy bubble;
/// the coach's Markdown sits left with no bubble; notices are muted and
/// small; a stopped partial reads as the coach, with a caption.
struct MessageBubble: View {
    let message: ChatSession.DisplayMessage

    var body: some View {
        switch (message.role, message.kind) {
        case (.user, _):
            HStack {
                Spacer(minLength: 48)
                Text(message.text)
                    .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, Spacing.sm)
                    .background(ApexPalette.userBubble, in: .rect(cornerRadius: Radius.lg))
                    .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexPalette.userBubbleBorder, lineWidth: 1))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("coach.message.user")
        case (.assistant, .notice):
            Text(message.text)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .italic()
                .foregroundStyle(ApexColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("coach.message.notice")
        case (.assistant, .stopped):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                MarkdownText(message.text, color: ApexColor.textSecondary)
                Text("Stopped")
                    .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .foregroundStyle(ApexColor.textMuted)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("coach.message.stopped")
        case (.assistant, .turn):
            MarkdownText(message.text)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("coach.message.assistant")
        }
    }
}

/// The coach's text as it arrives, with the blinking cursor from the web.
struct StreamingBubble: View {
    let text: String

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            MarkdownText(text)
            StreamingCursor()
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("coach.message.streaming")
    }
}

struct StreamingCursor: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = true

    var body: some View {
        Rectangle()
            .fill(ApexColor.accent)
            .frame(width: 2, height: 16)
            .opacity(visible ? 1 : 0.15)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true)) { visible = false }
            }
            .accessibilityHidden(true)
    }
}

/// Three dots (`.chat-typing` on the web) while the first token is on its way.
struct TypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(ApexColor.textMuted)
                    .frame(width: 6, height: 6)
                    .offset(y: phase ? -3 : 0)
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 0.4).repeatForever(autoreverses: true).delay(Double(index) * 0.13),
                        value: phase
                    )
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.md)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .onAppear { phase = true }
        .accessibilityLabel("The coach is typing")
    }
}
