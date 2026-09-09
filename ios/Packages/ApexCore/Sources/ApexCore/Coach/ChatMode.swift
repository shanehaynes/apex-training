import Foundation

/// Which coach a `ChatSession` talks to. The server picks the tool list and
/// the system prompt from this (`api/chat.ts` → `api/_lib/coach/context.ts`):
/// `chat` gets the eight mutation tools; `builder` and `analytics` get their
/// single draft-reducing tool and carry the current draft in `context`.
public enum ChatMode: String, Codable, Sendable, CaseIterable {
    case chat
    case builder
    case analytics
}
