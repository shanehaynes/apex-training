# C03 · Calendar annotations: table, handler, chips on days and events, block strip

## Goal
The coach can leave a note on a day, an event or a block, and the athlete sees it where the
thing lives — a small chip on the day cell or event chip, a strip in the block detail — with a
dismiss action. This lane ships the storage, the API, the client context and the rendering. The
chat tool that writes annotations (`leave_note`) lands in wave D once both C02 and this lane
are on `main`; this lane exposes a handler `POST` so the tool has something to call, and seeds
nothing.

Why: the coach's only surface is the chat window. A note that says "deload this week — load
ratio 1.4" is worth more on the calendar week it refers to than in a thread nobody reopens.

## Context you need
- Calendar rendering: `src/components/calendar/{Calendar,MonthView,WeekView,DayView,DayCell,EventChip}.tsx`
  (props at the top of each; `DayCell` is memoized — keep it so), block detail
  `src/components/blocks/BlockDetail.tsx`. Contexts and providers: `src/context/*Context.tsx`
  nested in `src/App.tsx` (`ScheduleProvider > BlocksProvider > AnalyticsProvider > MealsProvider
  > CalendarProvider`); the pattern for a fetch-once, refresh-on-demand context is
  `src/context/BlocksContext.tsx` + `src/context/blocks.ts` (hook + types split so components
  import the hook file).
- Persistence pattern: `api/_lib/handlers/coachConversations.ts` (routing by method + body
  shape, `requireUser`, `enforceRateLimit`, `.eq('user_id', userId)` on every query), registered
  in `api/_lib/app.ts` via `bridge`. Migration style:
  `supabase/migrations/phase46_coach_conversations.sql` — WHY header, RLS on, and copy its GRANTS
  block verbatim (revoke from anon/authenticated, grant service_role); the rls-coverage
  integration test checks exactly that.
- Types: `src/lib/db/database.types.ts` is generated from the local stack, which you do not
  have. Hand-write the `coach_annotations` block in the generator's exact style (copy the
  `coach_conversations` block) and add a row type in `src/lib/db/types.ts`. Flag under NOT
  VERIFIED; CI's `full` job checks drift.
- Styling: `src/styles/app.css` is off limits. New CSS in `src/components/calendar/annotations.css`,
  imported where the chip renders; tokens from `src/styles/tokens.css` (see
  `src/components/sidebar/chat-reads.css` for a small recent example).
- Client API helpers: `src/lib/api.ts` (`getJson`/`postJson`/`deleteJson`).
- Mock e2e: `e2e/` has Playwright specs against the mock backend (see how A04 added one for the
  confirm preview, `git log --stat -- e2e | head`); add one that renders a seeded annotation chip
  and dismisses it, if the mock layer lets you seed a table cheaply — else say so.

## Ownership
- New: `supabase/migrations/phaseXX_coach_annotations.sql` (literal `XX`; the orchestrator
  claims the number at PR open — this overrides the common "never touch migrations" line for
  this one new file), `api/_lib/handlers/coachAnnotations.ts`, `src/lib/coach/annotations.ts`
  (pure: types, severity enum, target resolution helpers), `src/context/AnnotationsContext.tsx`
  + `src/context/annotations.ts`, `src/components/calendar/AnnotationChip.tsx`,
  `src/components/calendar/annotations.css`, tests, one mock e2e spec.
- Edit: `src/components/calendar/{DayCell,EventChip}.tsx`, `src/components/blocks/BlockDetail.tsx`,
  `src/App.tsx` (provider nesting only: `AnnotationsProvider` inside `BlocksProvider`),
  `src/lib/api.ts`, `src/lib/db/database.types.ts` (hand-written block only),
  `src/lib/db/types.ts`, their tests.
- Append-only, at a named anchor: `api/_lib/app.ts` — one line directly after the `/events`
  route; `api/_lib/handlers/account.ts` — `'coach_annotations'` directly after
  `'workout_events'` in `USER_DATA_TABLES`. Lane C02 appends at different anchors in the same
  two files; touch nothing else in them.
- Not yours: `api/chat.ts`, `src/lib/coach/{prompt,schemas,tools}.ts`, `src/hooks/useChat.ts`,
  `src/components/sidebar/**`, `evals/**`, migrations other than yours.

## Table
```
coach_annotations(
  id uuid pk default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('day','event','block')),
  target_id text not null,       -- 'YYYY-MM-DD' for day; the event occurrence id; the block uuid
  body text not null check (length(body) between 1 and 400),
  severity text not null default 'info' check (severity in ('info','caution','alert')),
  created_by text not null default 'coach' check (created_by in ('coach','reflection','user')),
  created_at timestamptz not null default now(),
  dismissed_at timestamptz
)
index (user_id, target_kind, target_id) where dismissed_at is null
```

## Steps
1. Migration + hand-written types + row type.
2. Handler `/api/coach-annotations`: `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD` (non-dismissed
   annotations whose day target falls in range, plus every non-dismissed event/block annotation
   — hobby scale, one query each), `POST { target_kind, target_id, body, severity? }` create
   (server sets `created_by: 'coach'`; the wave-D tool calls this), `DELETE { id }` sets
   `dismissed_at`. Rate-limited like the conversations handler.
3. Client: `src/lib/api.ts` helpers; `AnnotationsContext` loads the visible range on mount and
   on range change (subscribe to the calendar's visible month via the existing calendar context
   or accept a `from/to` from `Calendar.tsx` — pick the cheaper, say which), exposes
   `byDay(date)`, `byEvent(id)`, `byBlock(id)`, `dismiss(id)` (optimistic), `refresh()`.
4. Rendering: `AnnotationChip` — a compact pill with the severity colour, the first ~40 chars,
   a title attribute with the full body, and a dismiss (×) that stops propagation so the day
   cell's own click does not fire. `DayCell` renders up to two chips (then "+n"); `EventChip`
   renders one inline marker when the event has annotations; `BlockDetail` renders a strip
   listing the block's annotations with dismiss.
5. Tests: handler (scoping, validation, dismiss), context reducer/selectors, chip rendering
   (vitest + testing-library as the repo does), the mock e2e.
6. README: one paragraph under the coach section.

## NOT VERIFIED to carry forward
The migration applied to a real stack; `database.types.ts` drift; the mock e2e if the browser
cannot launch in your container (CI's `e2e-mock` covers it).
