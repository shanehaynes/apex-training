# D03 · The weekly review as a document: plan vs done, physiology, doctrine check, next week

## Goal
On demand, the athlete asks for "this week's review" and gets a structured document, not a chat
reply: what was planned vs done, the physiology panel, one doctrine check with a cited line,
memory proposals, and a "next week" proposal — a short list of concrete `create_event` /
`update_event` calls the athlete accepts one at a time through the existing confirm executor.
Generated on the athlete's own key with their coach model, structured output parsed strictly,
stored nowhere in v1 (regenerate on demand; say so under DECISIONS).

Why: the monthly review email is a recap; the weekly one is a decision surface. Structured
output makes each section a component and each proposal an actionable card.

## Context you need (all on `main`)
- **Inputs, all server-side:** `fetchExpandedSchedule(supabase, userId, today)` in
  `api/_lib/mcp/data.ts` (the events with completion for a window — read how `api/_lib/coach/context.ts`
  calls it); `fetchPhysiologyInputs(supabase, userId, todayIso)` in `api/_lib/coach/physiology.ts`
  → `computePhysiology` / `describePhysiology` in `src/lib/physiology/index.ts`;
  `listConfirmed(supabase, userId)` + `toPromptEntries` in `api/_lib/coach/memory.ts`;
  `DOCTRINE_INDEX`, `readDoctrine` in `src/lib/coach/doctrine/index.ts`; the active block via
  whatever `buildChatContext` uses for `blockSection`. Reuse `api/_lib/reviewData.ts`'s
  `fetchPeriodInputs` / `src/lib/review/stats.ts` measures where they fit a 7-day period.
- **Model call precedent:** `api/review-cron.ts` `generateCommentary` — `getAnthropicKey`,
  `makeAnthropicClient(apiKey)`, `resolveCoachModel(coachModel)`, `client.messages.create`. The
  handler runs inside the consolidated function (`maxDuration` 60 s): one call, `max_tokens`
  bounded (~3000), a JSON schema stated in the system prompt, one retry on a parse failure, then a
  422 with the parse error. Prefer `output_format`/structured outputs only if the installed SDK
  exposes them for `messages.create` without a beta client (check
  `node_modules/@anthropic-ai/sdk/resources/messages/`); otherwise prompt + strict parse, and say
  which under DECISIONS. No key → 402-style response the UI turns into "add your key in Profile".
- **Handler pattern:** `api/_lib/handlers/coachMemory.ts` (routing by method, `requireUser`,
  `enforceRateLimit(... 'writes')` for the POST — it spends the athlete's money — `.eq('user_id',
  userId)` on every read). Register in `api/_lib/app.ts` directly after `/analytics-tiles`.
- **Proposals → actions:** the "next week" items are tool inputs in the exact shapes of
  `createEventSchema` / `updateEventSchema` (`src/lib/coach/schemas.ts`), validated server-side
  before they are returned. The client renders each with A04's `previewForTool(name, input, ctx)`
  (`src/lib/coach/preview.ts`, needs the `CoachToolContext` the sidebar builds — read
  `ChatSidebar.tsx` for how) and an Accept button that POSTs `/api/coach-tool { name, input,
  today }` — the same confirmed executor the chat's confirm card uses — then refreshes the
  schedule (`useSchedule().refresh` or the equivalent the sidebar calls after a confirm). Memory
  proposals are cards that POST `/api/coach-memory { kind, content }` (`addCoachMemory`). Do not
  fork the executors or the queue.
- **Overlay pattern:** `src/components/analytics/AnalyticsView.tsx` mounted from
  `src/components/layout/AppShell.tsx` and opened through `src/context/calendar.ts` actions; the
  calendar toolbar in `src/components/calendar/Calendar.tsx` is where the "Weekly review" entry
  goes (an icon button beside the view switch; on ≤768px it can sit in the same row).
- **Styling:** `src/styles/app.css` off limits; new `src/components/review/weekly-review.css`.
- **Doctrine check:** the document's `doctrine` section is `{ topic, line, verdict, note }` — the
  model must quote one line from the topic it names; validate server-side that the quoted line
  occurs in `readDoctrine(topic)` (normalized whitespace) and drop the section with a note if not.

## Output schema (server validates; client renders)
```
{
  week: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
  planVsDone: { planned: number, completed: number, minutesPlanned: number, minutesDone: number,
                misses: [{ eventId, title, date, why?: string }] },
  physiology: { summary: string, flags: string[] },          // from describePhysiology + model gloss
  doctrine: { topic: string, line: string, verdict: 'aligned' | 'drifting' | 'contradicted', note: string } | null,
  memoryProposals: [{ kind, content, why }],                 // ≤ 3
  nextWeek: [{ tool: 'create_event' | 'update_event', input: {...}, why: string }],  // ≤ 7
  headline: string                                           // one sentence
}
```

## Ownership
- New: `api/_lib/review/weekly.ts` (inputs + prompt + parse/validate, pure where possible),
  `api/_lib/handlers/weeklyReview.ts`, `src/lib/review/weekly.ts` (client types + the shape
  guard, pure), `src/components/review/**` (`WeeklyReviewView.tsx`, section components,
  `weekly-review.css`), tests, one mock e2e (open → rendered document from a stubbed response →
  accept one next-week item → confirm executor called) if the mock layer allows stubbing the
  model call; else say so.
- Append-only at a named anchor (lane D02 appends to the same files at different anchors —
  touch nothing else in them):
  - `src/context/calendar.ts`: state flag `weeklyReviewOpen` directly after `blocksOpen`,
    actions `OPEN_WEEKLY_REVIEW` / `CLOSE_WEEKLY_REVIEW` directly after `CLOSE_BLOCKS` in the
    union, reducer cases directly after the blocks cases.
  - `src/components/layout/AppShell.tsx`: one line directly after the `blocksOpen` line, import
    next to `BlocksView`'s.
  - `src/lib/api.ts`: your helpers directly after `archiveCoachMemory` and before the
    `// ── Coach annotations` header.
  - `api/_lib/app.ts`: `app.all('/weekly-review', …)` directly after `/analytics-tiles`.
  - `README.md`: one bullet directly after the annotations bullet ("Notes land where they refer").
  - `src/components/calendar/Calendar.tsx`: the toolbar button only.
- Not yours: `src/lib/coach/{prompt,schemas,tools,preview}.ts` (read them, do not edit),
  `api/chat.ts`, `src/hooks/useChat.ts`, `api/review-cron.ts`, `src/components/notebook/**`
  (D02), `src/components/profile/**`, migrations, `database.types.ts`, evals.

## Steps
1. `api/_lib/review/weekly.ts`: gather inputs for the ISO week containing `today` (query
   `?week=YYYY-MM-DD` optional, default this week), build the recap + system prompt with the
   schema, parse + validate (tool inputs against the schemas' required fields; doctrine line
   check; caps).
2. Handler: POST generates (rate-limited on `writes`), returns the document; GET is not needed in
   v1 (nothing stored) — 405.
3. Client: `src/lib/api.ts` helper, reducer + AppShell + toolbar entry, the view: headline,
   plan-vs-done table, physiology, doctrine card with the quoted line, memory proposal cards,
   next-week cards with previews and Accept (per item; accepted items grey out; errors toast).
   Loading state with the model badge; "add your key" state.
4. Tests: inputs → prompt (snapshot-free assertions), parse/validate (bad JSON, missing fields,
   an invented doctrine line, an `update_event` without an id), handler auth + rate limit +
   no-key, view rendering from a fixture document. Mock e2e if feasible.
5. Report.

## NOT VERIFIED to carry forward
Live model output (no key); structured-output support on the installed SDK (decision recorded);
mock e2e in your container if Playwright cannot launch.
