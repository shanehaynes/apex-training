# W6 — Coach tab

**Machine:** Mac · **Depends on:** W5a (W5b for actions) · **Unblocks:** W7, W9 (their coach drawers reuse this)
**Status:** in progress — PR A (`feat/w6-coach-core`) open; B (UI) and C (smoke + TestFlight 3) to follow

## Goal
The coach as a first-class tab: streaming, Markdown, confirmations, local history. TestFlight build 3.

## Scope
In:
- `ApexCore.ChatSession` actor: `ApiMessage` blocks, `appendUserText`, `toPendingActions`,
  `settleHead`, tools-off follow-up, abort; 402/429 inline states.
- Thread UI: Markdown rendering (D-014: `AttributedString(markdown:)` + block renderer),
  streaming cursor, typing indicator, confirmation card (server `label`, Confirm/Cancel,
  "1 of N", input disabled while pending, double-tap latch), Stop, Coach's Notes, model badge.
- Composer: multiline, explicit Send, keyboard-avoiding, above the tab bar.
- Conversations (D-013): GRDB `conversations` / `messages`; list, new, resume, delete.
- Haptic on confirm.
Out: builder/analytics coach drawers (W7/W9 reuse `ChatSession` with a mode).

## Backend contract consumed
`POST /api/chat` v2, `POST /api/coach-tool`, `GET /api/profile` (key status, model).

## Acceptance
- `swift test`: queue cases mirrored from `src/lib/coach/__tests__/actionQueue.test.ts`;
  NDJSON parser with split chunks; 402/429 mapping.
- Snapshots: thread with user/assistant/markdown, confirmation card, key-setup state.
- Device: a create-event request round-trips (card → confirm → event appears on Schedule via
  realtime); Stop mid-stream cancels the upstream call (check Vercel logs for abort).
- TestFlight build 3.

## Session log
- 2026-09-08 · Mac · Plan and PR A. Landing as three PRs in the W4 mould: A ApexCore coach core +
  one backend field + fixtures (this PR, Linux-provable); B GRDB conversations + `CoachModel` +
  views + mock routes + snapshots; C smoke leg + `MARKETING_VERSION` 0.4.0 + TestFlight build 3.
  Plan of record: `~/.claude/plans/lets-now-go-to-scalable-bonbon.md` on Shane's Mac. Decided
  with Shane before starting: model via `GET /api/profile`; a minimal key sheet in W6 (W11 reuses
  it); Coach's Notes always starts a new conversation; Stop keeps the partial text display-only.
  - **Corrections to the brief found on the way in:** `GET /api/profile` never carried the
    coach model (the web reads the `profiles` row over RLS) — it now returns `coachModel` and a
    server-resolved `coachModelLabel` (backend-changes.md, W6 addendum). The web's card copy is
    "· N more after this", not "1 of N" — the brief's wording stands (`ChatCopy.cardPosition`).
    The web persists an empty assistant turn as `[]` when a stream yields nothing (a latent 400 on
    the next call) — iOS drops the turn. A persisted thread can exceed the server's 80-message /
    400 KB cap, which the web never could — `ActionQueue.historyWindow`. See D-025.
  - **ApexCore (Linux-provable):** `Coach/` — `ChatMode`, `ApiMessage` + `ContentBlock` +
    `ToolUseBlock` (label kept locally, `strippingLabels()` for the wire) + `ToolResult`,
    `ActionQueue` (the web's `appendUserText` / `toPendingActions` / `settleHead` with their
    vectors copied verbatim, plus `assistantMessage`, `pendingTail`, `historyWindow`),
    `ChatCopy`, `ChatSession` actor (states idle · streaming · awaitingConfirmation(k of N) ·
    executing · followUp · blocked(missingKey | rateLimited(until)); `send` / `confirmHead` /
    `cancelHead` / `stop` / `notes` / `load` / `startNewConversation` / `keyAdded`; events
    stream incl. `.mutationConfirmed` and `.toast`), `MarkdownBlocks` (paragraph / heading /
    list / code, streaming-tolerant). `Cache/` — `ConversationStore` protocol (+ `Conversation`,
    `StoredMessage` with `kind` turn | notice | stopped) and `MemoryConversationStore`. `API/` —
    `Endpoint.chat` (strips labels, omits `model`/`context` when nil), `.coachTool`,
    `.setAnthropicKey`. `ProfileResponse` gains optional `coachModel` / `coachModelLabel`.
    `ScriptedTransport` in the tests now streams chunk by chunk with a hold-open gate and counts
    consumer cancellations. 246 `swift test` cases green (76 new: queue vectors, coding, window,
    endpoints, 25 session cases incl. Stop mid-stream, fold after a stopped follow-up, 402/429
    blocks, relaunch re-derivation, 7-byte chunking; markdown; store).
  - **Backend:** `handlers/profile.ts` GET reads `profiles.coach_model` and resolves the label
    with `resolveCoachModel`; unit test + integration assertion; `profile.json` regenerated.
  - **Not done here (PR B/C):** everything Apple-side — `v3_conversations`, `GRDBConversationStore`,
    `CoachModel`, the thread / composer / card / Notes / badge / list views, `AnthropicKeyView`,
    `MarkdownText`, mock `/api/chat` (chunked) + `/api/coach-tool` routes, snapshots, smoke,
    TestFlight build 3.
