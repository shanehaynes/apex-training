import Foundation

/// Every string the coach thread shows that is not the model's own text.
/// Matches the web (src/hooks/useChat.ts, ChatSidebar.tsx) except where iOS
/// has its own path — the 402 copy points at the key sheet, not the profile.
public enum ChatCopy {
    // Inline notices (display-only rows, never sent to the model).
    public static let keySetup = "To use the coach, add your Anthropic API key."
    public static let rateLimited =
        "The coach is taking a breather — too many requests in a short window. Try again in a few minutes."
    public static let genericFailure = "Sorry, I ran into an error. Please try again."
    public static let notesFailure = "Couldn't reach the coaching server. Please try again."
    public static let confirmTroubled = "Done — but I had trouble confirming. The change was applied."
    public static let emptyReply = "The coach didn't answer. Please try again."

    // tool_result texts.
    public static let cancelledByUser = "Cancelled by user."
    public static let executorFailed = "The operation failed — something went wrong on the backend."

    // Toasts on the confirm path.
    public static let applyFailed = "Applying coach action failed"
    public static let aiCapReached = "Daily AI mutation cap reached."

    /// Coach's Notes is a tools-off turn with this one synthetic user message.
    public static let notesPrompt = "Give me my coaching briefing for today."
    public static let notesTitle = "Coach's Notes"

    // Empty states and the composer.
    public static let emptyWithKey = "Ask anything, or get your daily briefing below."
    public static let emptyWithoutKey =
        "The coach runs on your own Anthropic API key. Add one to unlock chat and post-workout summaries."
    public static let addKey = "Add API key"
    public static let placeholder = "Ask your coach…"
    public static let placeholderNeedsKey = "Add your API key to chat…"
    public static let placeholderPending = "Confirm or cancel above first…"

    /// "1 of 3" on the confirmation card (the brief's wording; the web says
    /// "· 2 more after this").
    public static func cardPosition(index: Int, total: Int) -> String { "\(index) of \(total)" }

    /// A conversation's title: the first line of its first message, trimmed.
    public static func title(from text: String, limit: Int = 60) -> String {
        let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = firstLine.trimmingCharacters(in: .whitespaces)
        return trimmed.count <= limit ? trimmed : String(trimmed.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
