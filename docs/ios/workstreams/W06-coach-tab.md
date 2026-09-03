# W6 — Coach tab

**Machine:** Mac · **Depends on:** W5a (W5b for actions) · **Unblocks:** W7, W9 (their coach drawers reuse this)
**Status:** blocked on W5a

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
- (none yet)
