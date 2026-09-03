# W5a — Backend: chat v2 (server-side prompt assembly)

**Machine:** Linux · **Depends on:** W0 · **Unblocks:** W5b, W6
**Status:** blocked on W0

## Goal
`/api/chat` builds the system prompt itself from the caller's data, so any client sends
`{ mode, messages, withTools, today, context }` and receives labelled tool_use events.

## Scope
In:
- `api/_lib/coach/context.ts`: load schedule window (`fetchExpandedSchedule`), definitions,
  today's meals, profile fields, block summary, completion rate → `buildSystemPrompt` /
  `buildBuilderPrompt` / `buildAnalyticsPrompt`.
- `api/chat.ts`: new body; legacy `{ system }` accepted; `label` on tool_use computed with a
  real `CoachToolContext`; usage logging unchanged.
- `describeDraft` / `describeChartDraft` into the API graph (`.js` specifiers).
- Web `useChat` + the three sidebars switch to the new body (drop client prompt building where
  the server now covers it).
- Fixture `ios/Fixtures/chat-stream.ndjson` (recorded stream with text + tool_use + done).
Out: tool execution (W5b).

## Acceptance
- Unit: `context.ts` produces byte-identical system text to the client builder for the same
  inputs (golden test using the seeded user).
- Integration: chat v2 with `mode: 'builder'` + a draft yields a `tool_use` with `label`.
- Preview deploy curl (`scripts/deploy-verify.sh`) proves `api/chat.ts` still cold-starts.
- Evals: nightly run unchanged (they exercise executors, not the transport).
- Playwright `mobile-chat` and coach specs green.

## Session log
- (none yet)
