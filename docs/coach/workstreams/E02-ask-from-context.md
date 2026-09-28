# E02 · Ask the coach about this session — from the workout modal and the tracker

## Goal
One button in two places — the workout modal ("Ask the coach") and the post-workout summary
("Ask the coach about this session") — that opens the coach with that session pinned: the
coach reads the workout's prescription and logged results before it answers, keeps to that
session unless asked wider, and when the athlete says how it felt ("this felt heavy", "knee
was sore on the descents") offers to remember it through the existing memory confirm card.
Decision D-C08: the pin is a hidden user turn with a short display line, never a prompt change.

Why: the coach can read a session (`get_workout_detail`, `get_session_summaries`) since wave
B, but the athlete has to describe which one. The modal and the tracker already know.

## Context you need (all on `main`)
- **Hidden text the model sees, the thread never shows.** `src/hooks/useChat.ts`:
  `BRIEFING_PROMPT` (line ~42) and `rowsForBriefing` (~243) store a user turn with
  `display_text: null`; `hydrateFromRows` skips null display rows; `turnRow(role, apiContent,
  displayText | null)` (~206). `sendMessage(content, ctx)` (~437) builds `userDisplayMsg`
  from `content` and `turnRow('user', content, content)`. Your change: a third argument
  `opts?: { display?: string }` — `display` becomes the visible message and the stored
  `display_text`; `content` stays the API text. `appendUserText` (actionQueue.ts) unchanged.
- **Nothing opens the chat today.** `src/components/layout/AppShell.tsx` always mounts
  `<ChatSidebar />` (line 48); the phone's Coach tab is `useState<MobileTab>` (line 26,
  `MobileBottomNav` `MobileTab = 'calendar' | 'coach'`); CSS hides the column below 1025px
  unless that tab is open (`ChatSidebar.tsx` lines 22–24). `src/context/calendar.ts`
  `CalendarAction` has no chat action; open/close pairs end with the notebook entries
  (`OPEN_NOTEBOOK` / `CLOSE_NOTEBOOK`, `notebookOpen`); reducer cases live in
  `src/context/CalendarContext.tsx`.
- **The two surfaces.** `src/components/modal/WorkoutModal.tsx` (no props; `state.selectedEvent`;
  the `modal-completion` row lines ~326–345 with Start/View Workout and Mark as Complete;
  `CLEAR_EVENT` closes). `src/components/tracker/WorkoutSummary.tsx` (props `event, …,
  coachText, coachStatus, onClose, onDone`; the footer's single "Back to calendar" button lines
  ~155–159) rendered by `TrackerView.tsx` lines ~195–208 with `onDone={() => { dismissSummary();
  dispatch({ type: 'STOP_TRACKING' }); }}`.
- **What the coach can read.** `get_workout_detail { event_id, date }` ("Full prescription and
  logged results (sets, cardio, session timing) for one workout occurrence"; a series base id is
  accepted too) and `get_session_summaries { start?, end?, limit? }` — both in the chat tool
  list already; the server loop runs them and the sidebar shows "Checked: …" chips.
- **Memory.** A `memory` tool_use that is not `view` becomes a confirm card in `ChatSidebar`
  (`ConfirmPreview` case `'memory'`) → `/api/coach-tool` → `applyMemoryCommand` with
  `sourceKind: 'chat'`. Nothing to add: the hidden text only tells the coach when to offer it.
- **ChatSidebar**: `resolveContext` (line ~239) supplies `{ today }`; `useChat()` gives
  `sendMessage`, `isLoading`, `pendingAction`, `messages`.
- **Decision-id cleanup you own:** `src/components/sidebar/ChatSidebar.tsx:127` cites "D-C03"
  for "nothing is remembered without the click"; the log's D-C03 is embeddings, D-C02 is the
  proposal gate. Change the comment to D-C02.
- **Mock e2e:** `e2e/mock/builder-coach.spec.ts` captures chat request bodies; use the same
  route stub to assert the hidden text.

## Interface contract (do not rename)
- `src/lib/coach/askContext.ts` (pure): `AskCoachRequest = { kind: 'session'; eventId: string;
  date: string; title: string; source: 'modal' | 'tracker' }`; `askCoachPrompt(req): string` —
  the hidden text: the athlete opened the workout `<title>` on `<date>` (occurrence id
  `<eventId>`) from the calendar / just finished tracking it; call `get_workout_detail` with that
  id and date first (and `get_session_summaries` for that day when it was tracked) before
  answering; keep to this session unless the athlete widens the question; if they say how it
  felt or what hurt, offer to remember it (the memory tool) rather than deciding for them;
  answer their actual question if one follows, else open with what you see; user-authored
  strings sanitised as the prompt does (`sanitizeInlineText`). `askCoachDisplay(req): string` —
  "Asked about: <title>, <date>" (a `format(date, 'EEE MMM d')` date).
- `src/context/calendar.ts`: state `askCoach: AskCoachRequest | null` (after `notebookOpen`);
  actions `ASK_COACH { payload: AskCoachRequest }` / `CLEAR_ASK_COACH` appended after
  `CLOSE_NOTEBOOK`; reducer cases after the notebook cases in `CalendarContext.tsx`. `ASK_COACH`
  also clears `selectedEvent` (the modal closes so the phone shows the coach).
- `src/hooks/useChat.ts`: `sendMessage(content, ctx, opts?: { display?: string })`.
- `ChatSidebar.tsx`: an effect on `state.askCoach` — when set, `!isLoading`, and no
  `pendingAction`: `sendMessage(askCoachPrompt(req), await resolveContext(), { display:
  askCoachDisplay(req) })` then `dispatch({ type: 'CLEAR_ASK_COACH' })`; otherwise wait (the
  effect re-runs on those deps). Scroll to the bottom as a sent message does.
- `AppShell.tsx`: one effect — when `state.askCoach` becomes non-null and `isMobile`,
  `setMobileTab('coach')`.
- `WorkoutModal.tsx`: "Ask the coach" (`data-testid="ask-coach"`) in the completion row →
  `dispatch({ type: 'ASK_COACH', payload: { kind: 'session', eventId, date, title, source:
  'modal' } })`. `WorkoutSummary.tsx` gains `onAskCoach: () => void` and a second footer button
  "Ask the coach about this session" (`data-testid="ask-coach-summary"`); `TrackerView.tsx`
  passes `onAskCoach={() => { dismissSummary(); dispatch({ type: 'STOP_TRACKING' }); dispatch({
  type: 'ASK_COACH', payload: {…, source: 'tracker'} }); }}`.

## Ownership
- Yours: `src/hooks/useChat.ts` (the `opts` argument and its two uses — nothing else in the
  hook), `src/components/sidebar/ChatSidebar.tsx` (the effect + the comment fix), `src/context/
  calendar.ts`, `src/context/CalendarContext.tsx`, `src/components/layout/AppShell.tsx` (one
  effect), `src/components/modal/WorkoutModal.tsx`, `src/components/tracker/WorkoutSummary.tsx`,
  `src/components/tracker/TrackerView.tsx`, new `src/lib/coach/askContext.ts`, tests
  (`useChat` display override + persisted rows; reducer; `askContext`; `ChatSidebar` effect waits
  while loading; modal/summary buttons dispatch), mock e2e `e2e/mock/ask-coach.spec.ts` (open a
  workout → Ask → the chat request body's last user message carries the hidden text and the
  thread shows the display line; phone viewport lands on the Coach tab), README: one paragraph
  in the coach section directly before the "Weekly review" bullet.
- Not yours (lane E01 runs in parallel): `api/**`, `src/lib/coach/{prompt,schemas,tools,
  memory}.ts`, `src/lib/api.ts`, `src/lib/blocks/**`, `src/components/blocks/**`, `evals/**`,
  migrations, iOS. No `PROMPT_VERSION` bump: your text is a user turn, not the prompt.
- Styling: inline or `src/components/sidebar/chat-reads.css` for a display-line style if one is
  needed; `src/styles/app.css` is off limits.

## Steps
1. `askContext.ts` + tests. 2. Reducer + `useChat` `opts` + tests. 3. `ChatSidebar` effect +
AppShell tab flip + tests. 4. Modal and summary buttons + tests. 5. Mock e2e. 6. README; report.

## NOT VERIFIED to carry forward
Live coach behaviour on the hidden text (no key; the orchestrator can add an eval case later —
FOLLOW-UP); the tracker path end-to-end on a phone (mock e2e covers the modal path; say what
the tracker path covers).
