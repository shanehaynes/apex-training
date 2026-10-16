// Size bounds on a coach conversation, shared by the request that sends one
// (api/chat.ts) and the store that saves one (handlers/coachConversations.ts).
// They lived as two copies that drifted: chat moved to 160 for the sight loop
// while the store kept 80, so a thread could pass every request and still be
// refused at save time.

/**
 * Messages in one conversation. Well above legitimate usage — a request
 * outside it is a bug or abuse, not a long conversation. The count was 80
 * before the sight loop; a turn that reads twice now stores two
 * assistant/user pairs on top of its own, so the same conversation trips a
 * count bound about three times sooner. 160 keeps the ~10x headroom the old
 * bound had.
 */
export const CONVERSATION_MAX_MESSAGES = 160;

/**
 * Serialized bytes of one request's messages or one saved batch. Unchanged
 * by the sight loop — read results are the bytes that grow, and 400 KB is
 * still far past any real thread. The real fix is context editing /
 * compaction of old tool results, not a higher number (FOLLOW-UPS).
 */
export const CONVERSATION_MAX_BYTES = 400_000;
