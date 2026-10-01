import Foundation

/// Which coach a `ChatSession` talks to. The server picks the tool list and
/// the system prompt from this (`api/chat.ts` → `api/_lib/coach/context.ts`):
/// `chat` gets the mutation tools; `builder` and `analytics` get their
/// single draft-reducing tool and carry the current draft in `context`;
/// `planner` gets `update_block_draft` plus the read tools and carries the
/// block draft in `context` (decision D-C07).
public enum ChatMode: String, Codable, Sendable, CaseIterable {
    case chat
    case builder
    case analytics
    case planner
}
