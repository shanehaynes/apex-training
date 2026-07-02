# Workout Tracking — Plan & Spec

**Version:** 1.1
**Date:** 2026-07-02
**Status:** Implemented — see Section 9 for resolutions and corrections made during implementation
**Owner:** Shane Haynes
**Implementer:** Fable 5 (via Claude Code)

---

## 0. Purpose of this document

This is a handoff spec for a self-contained project inside the Apex Training codebase: add
the ability to actually *run* a workout — start it, log real weights/reps/sets/duration/cardio
data against each exercise, and finish it — where today the app only lets you view what's
planned and toggle a binary "completed" flag.

This doc follows the same shape as [RECURRENCE_ENGINE_SPEC.md](RECURRENCE_ENGINE_SPEC.md):
Section 1 is verified against the current code, not assumed. Section 8 lists genuinely open
questions that came out of a discussion with Shane and were not settled — resolve those
before or during implementation, don't guess.

---

## 1. Current-State Findings

- **Events are already workout-typed**, not generic calendar items. `WorkoutEvent`
  ([src/types/workout.ts](src/types/workout.ts)) has `type: 'stretching'|'morning-routine'|'weights'|'climbing'|'cardio'|'yoga'`,
  plus `warmup?`, `exercises`, `cooldown?` — each an `Exercise[]`.
- **`Exercise` stores one uniform intended target per exercise, not per set:**
  ```ts
  interface Exercise {
    id: string;
    name: string;
    category: 'strength' | 'stretch' | 'cardio' | 'skill' | 'mobility';
    sets?: number;
    reps?: string;
    duration?: string;
    weight?: string;
    restPeriod?: string;
    notes?: string;
    imageUrl?: string;
    muscleGroups?: string[];
  }
  ```
  `sets: 4, reps: "5", weight: "185lb"` currently means "4 sets of 5 @ 185," repeated
  identically across all sets. There is no way today to express a ramp/pyramid
  (135×5, 165×5, 185×5, 205×3) — every set shares one target.
- **Completion is already decoupled from the event object.** Toggling "Mark as Complete" in
  [src/components/modal/WorkoutModal.tsx:121-132](src/components/modal/WorkoutModal.tsx#L121-L132)
  does **not** touch `workout_events` or `WorkoutEvent.isCompleted` in place. It calls
  `toggleCompletion()` in [src/context/ScheduleContext.tsx:306-346](src/context/ScheduleContext.tsx#L306-L346),
  which optimistically updates local state and `POST`s to `/api/completions`
  ([api/completions.ts](api/completions.ts)), which upserts a row in `workout_completions`
  and appends to `workout_completion_log` — both keyed by `(event_id, event_date)`, not
  `event_id` alone.
- **This composite key matters because recurring events are not materialized per occurrence.**
  Per [RECURRENCE_ENGINE_SPEC.md](RECURRENCE_ENGINE_SPEC.md), a recurring event is one row
  with a `recurrence_rule`, expanded virtually into occurrences on read. There is no
  database row that uniquely identifies "the July 9th instance of Tuesday Squats" — only
  `(event_id, date)` identifies it. **Any new table for set-level logs must use the same
  composite key**, exactly like `workout_completions` already does.
- **Migrations are file-based and phase-numbered**, applied by hand against a single Supabase
  project (no CI migration runner found): `supabase/migrations/phase2_events_tables.sql`,
  `phase3_enable_rls.sql`, `phase3_recurrence_rule.sql`. A new feature adds
  `phase4_workout_tracking.sql` to that folder and Shane runs it manually.
- **API writes go through Vercel Edge Functions using a service-role client**, never directly
  from the browser to Supabase (see `api/completions.ts`, `api/event-instances.ts`,
  `getSupabaseAdmin()` in `api/_lib/supabaseAdmin.ts`). This was a deliberate hardening — see
  commit `4bef16b "Lock down anon-key exposure: enable RLS and move writes to service-role
  API endpoints"`. **Any new write path must follow this pattern**, not add a new
  client-side Supabase write.
- **Navigation is reducer-state-based, not a router.** `CalendarContext`
  ([src/context/CalendarContext.tsx](src/context/CalendarContext.tsx)) holds
  `selectedView: 'month'|'week'|'day'` and `selectedEvent: WorkoutEvent | null`, rendered
  conditionally in `Calendar.tsx`. A new full-page view is another arm of that conditional,
  not a route.
- **The AI coach already reads completion data** in `ChatSidebar.tsx` (today's events,
  4-week completion rate) but nothing at set/rep/weight granularity — this project is what
  makes richer coaching possible, but building the coach-side analytics is not in scope here.

---

## 2. Goals

1. A "Start Workout" button on the event overlay that launches a dedicated, full-page,
   linear (single-sitting) tracking session for that specific event occurrence.
2. Per-set logging — actual weight/reps (or duration/reps for non-weighted work) — for
   every exercise in `warmup`, `exercises`, and `cooldown` alike. No lightweight/skip
   treatment for warmup or cooldown.
3. A read-only "planned" target shown immediately next to each set's editable actual field.
   Planned targets may vary set-to-set (ramps/pyramids), not just one repeated value.
4. Sets are freely addable/removable beyond what was planned.
5. Cardio exercises get a distinct, structured, manually-entered form (duration, distance,
   elevation gain, avg heart rate) instead of per-set rows.
6. A total elapsed-time metric for the session, started when "Start Workout" is tapped.
7. On "Finish": any planned set left untouched is recorded with actual = 0, and the event's
   existing completion flag is set via the **existing** `toggleCompletion`/`/api/completions`
   path — do not invent a second source of completion truth.
8. Everything logged remains editable after Finish. No locking.
9. All of the above is persisted per-set so it can feed richer AI-coach analytics later
   (that consumption is explicitly out of scope for this project — see Section 9).

---

## 3. Data Model

### 3.1 Planned targets: extend `Exercise`, don't replace it

Add an optional per-set array to the existing `Exercise` type:

```ts
interface PlannedSet {
  setNumber: number;
  targetWeight?: string;    // e.g. "185lb" — omit for bodyweight/duration work
  targetReps?: string;      // e.g. "5"
  targetDuration?: string;  // e.g. "60s" — stretch/yoga hold time
}

interface Exercise {
  // ...existing fields unchanged...
  plannedSets?: PlannedSet[];
}
```

**Backward compatibility technique:** don't require a backfill of every existing event's
JSONB. When the tracking view builds its set list for an exercise, if `plannedSets` is
present use it; otherwise **synthesize** `sets` (default 1) identical rows from the legacy
`reps`/`weight`/`duration` strings. Old events keep working in the tracker with a uniform
target, exactly as before; only newly-authored events (or ones someone deliberately edits)
get the richer varying-per-set shape. This avoids a risky one-shot data migration.

**Open question:** who writes `plannedSets` going forward — a future event-editing UI, the
AI coach's event-creation tool, or manual JSON/DB edits? Not answered yet; see Section 8.

### 3.2 Actuals: new tables, keyed like `workout_completions`

```sql
-- phase4_workout_tracking.sql

CREATE TABLE IF NOT EXISTS workout_sessions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id               TEXT NOT NULL,
  event_date             DATE NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL,
  finished_at            TIMESTAMPTZ,
  total_duration_seconds INTEGER,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, event_date)
);

CREATE TABLE IF NOT EXISTS workout_set_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         TEXT NOT NULL,
  event_date       DATE NOT NULL,
  section          TEXT NOT NULL CHECK (section IN ('warmup', 'exercise', 'cooldown')),
  exercise_id      TEXT NOT NULL,
  exercise_name    TEXT NOT NULL,      -- denormalized snapshot; exercise defs live in
                                        -- mutable JSONB, don't let a later edit orphan history
  set_number       INTEGER NOT NULL,
  planned_weight   TEXT,
  planned_reps     TEXT,
  planned_duration TEXT,
  actual_weight    TEXT,
  actual_reps      TEXT,
  actual_duration  TEXT,
  is_autofilled    BOOLEAN NOT NULL DEFAULT false,  -- true = zero-filled at Finish, not a
                                                     -- real 0-rep attempt; keep these
                                                     -- distinguishable for future analytics
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, event_date, section, exercise_id, set_number)
);

CREATE TABLE IF NOT EXISTS workout_cardio_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        TEXT NOT NULL,
  event_date      DATE NOT NULL,
  section         TEXT NOT NULL CHECK (section IN ('warmup', 'exercise', 'cooldown')),
  exercise_id     TEXT NOT NULL,
  exercise_name   TEXT NOT NULL,
  duration_minutes NUMERIC,
  distance        TEXT,
  elevation_gain  TEXT,
  avg_heart_rate  INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, event_date, section, exercise_id)
);
```

**Why three tables instead of one polymorphic table:** cardio fields (distance, elevation,
heart rate) share nothing structurally with set fields (weight, reps). Forcing them into one
wide table means most columns are null for every row. Three narrow tables, joined only at
the session/event/date level, keep each table's constraints meaningful and match how the
existing schema already separates `workout_completions` from `workout_completion_log`.

**Exercise ID stability concern:** `workout_set_logs`/`workout_cardio_logs` use `exercise_id`
as part of a uniqueness constraint. If a workout's exercise list is ever edited after
sets have been logged against it (id regenerated, exercise removed/reordered), those rows
become orphaned or collide. Verify how `Exercise.id` is currently generated/preserved across
edits before relying on it as a stable key — flagged in Section 8.

### 3.3 Write pattern

One endpoint, `api/workout-sessions.ts`, following the existing `api/completions.ts` shape
(service-role client, validate body, no per-user auth):

- `POST /api/workout-sessions/start` — `{ eventId, eventDate, startedAt }` → upsert
  `workout_sessions` row with `started_at`, `finished_at = null`.
- `PUT /api/workout-sessions/save` — `{ eventId, eventDate, setLogs[], cardioLogs[] }` →
  upsert each row by its unique key. Called on every meaningful edit (see autosave question,
  Section 8) and again at Finish. Idempotent by design, matching the "editable forever,
  re-savable" requirement — no separate "create" vs "update" branch needed.
- `POST /api/workout-sessions/finish` — `{ eventId, eventDate, finishedAt }` → server computes
  `total_duration_seconds` from `started_at`, zero-fills any `plannedSets` entries with no
  matching `workout_set_logs` row (`is_autofilled = true`), and internally calls the same
  logic `toggleCompletion` uses today (or the endpoint itself posts to the completions
  upsert + log) so completion state has exactly one code path, not two.

Doing the zero-fill **server-side** at finish (not client-side before the request) means a
client that crashes mid-request can't leave the event half-completed/half-zero-filled, and
it means the client doesn't need to know the full planned-set shape just to finish — it can
send only what was actually touched.

---

## 4. Functional Flow

1. User opens an event → `WorkoutModal.tsx`. A new "Start Workout" button is added to the
   `modal-completion` container, **before** the existing "Mark as Complete" button (per
   Shane's explicit ordering).
2. Tap → dispatch a new action (e.g. `SET_VIEW` payload `'tracker'`, or a dedicated
   `START_TRACKING` action) carrying both `event.id` **and** the currently-viewed occurrence
   `date` — not just the event id, per the recurrence-expansion finding in Section 1.
3. Tracking view (`TrackerView.tsx`, full page, new arm of `Calendar.tsx`'s conditional
   render) mounts, calls `POST /api/workout-sessions/start`, and starts a session-elapsed
   timer computed from server `started_at` (not a client `setInterval` counter — see
   Section 6 for why).
4. For each section (warmup → exercises → cooldown), for each exercise:
   - **Weighted/duration exercises** (strength, stretch, yoga, skill, mobility): render one
     row per planned set (from `plannedSets`, or synthesized — Section 3.1). Each row shows
     the uneditable planned target and an editable actual field alongside it. A control to
     add an extra unplanned set at the end.
   - **Cardio exercises**: render the structured form (duration, distance, elevation gain,
     avg heart rate) once per exercise, no per-set rows, no timer requirement.
5. User can tap "Finish" at any point, with any subset of exercises untouched.
6. `POST /api/workout-sessions/finish` computes total duration, zero-fills untouched planned
   sets, and marks the event complete via the existing completion path.
7. User lands back on the calendar (or a summary state — Section 8). Reopening the event and
   tapping "Start Workout" again (or a future "View Workout" affordance) re-enters the same
   `TrackerView` pre-populated from `workout_sessions`/`workout_set_logs`/`workout_cardio_logs`
   for that `(event_id, date)`, fully editable, no locking.

---

## 5. Suggested Implementation Techniques

- **Composite-key everything** by `(event_id, event_date)`, consistent with
  `workout_completions`. Don't let a new table assume `event_id` alone is unique.
- **Server-computed elapsed time.** Store `started_at` server-side at session start; compute
  `total_duration_seconds = finished_at - started_at` server-side at finish. A pure
  client-side `setInterval` stopwatch drifts when a mobile browser tab is backgrounded and
  gives an inaccurate number for exactly the metric this feature is supposed to make
  trustworthy for analytics.
- **One upsert-everything save endpoint**, not fine-grained per-set endpoints. Matches the
  "editable indefinitely" requirement, minimizes round trips, and keeps the client's job
  simple: serialize current form state, PUT it.
- **Reuse `toggleCompletion`/`/api/completions` for the completion side-effect** at finish
  instead of writing to `WorkoutEvent.isCompleted` directly — that field is already
  effectively legacy/display-only per Section 1's finding that completion truth lives in
  `workout_completions`.
- **Follow the `phaseN_description.sql` migration convention** already established —
  `phase4_workout_tracking.sql`.
- **Match the existing visual language for planned-vs-actual.** `PRD.md`'s design system
  already reserves `JetBrains Mono` for stat numbers and defines a `--text-muted` token.
  Rendering the planned target as small muted mono text beside (or as a placeholder above)
  the actual input is consistent with the app's existing conventions and satisfies "clean
  and unobtrusive" without inventing a new visual pattern.
- **Collapsible sections for warmup/cooldown** are worth considering purely for scroll length
  — full per-set tracking for every warmup exercise on top of the main lift set makes for a
  long page. Functionally all three sections behave identically either way; this is a layout
  suggestion, not a requirement.

---

## 6. Concerns & Tradeoffs

1. **No draft persistence, but data loss risk is real.** Shane specified linear,
   single-sitting sessions with no resume — but if the browser tab closes mid-workout
   (accidental swipe, crash, phone call) with only a Finish-time save, everything logged so
   far is lost, contradicting the goal of high-fidelity data for the coach. Recommend
   **autosaving on every set edit** (debounced) via the same `PUT /api/workout-sessions/save`
   used at Finish — this is cheap (the endpoint already needs to exist and be idempotent) and
   buys crash resilience without building any resume/draft-recovery *UI*. It does, however,
   raise a real question about what happens if a half-finished session's tab is reopened —
   see Section 8.
2. **Varying per-set planned targets require someone to actually author them.** Today every
   event's exercises are authored with one uniform target. Nothing in this project builds an
   authoring UI for ramps/pyramids — the schema supports it, but until something writes
   `plannedSets`, the tracker will only ever show synthesized uniform targets. Worth deciding
   whether that's acceptable for v1 or whether a minimal authoring path is needed alongside.
3. **Exercise ID stability** (Section 3.2) is unverified. If ids are regenerated on every
   event edit rather than preserved, the unique constraints on `workout_set_logs`/
   `workout_cardio_logs` will silently orphan historical logs the first time someone edits
   an exercise list after logging against it. This should be verified against
   `src/context/ScheduleContext.tsx`'s event-update path before relying on it.
4. **Warmup/cooldown getting full tracking treatment** is a deliberate choice (confirmed),
   but roughly doubles the number of interactive rows on the page for a typical strength
   workout with a multi-exercise warmup. Pure UX/scroll-length concern, not a data model one.
5. **Migrations are applied by hand**, not via CI. `phase4_workout_tracking.sql` needs to be
   run manually against the live Supabase project after review — same process as
   `phase3_recurrence_rule.sql`, just flagging it's a manual step, not automatic on merge.
6. **Total-time-for-cardio ambiguity.** Shane's answer ("no timer required, only to log that
   it occurred") most directly addresses the per-exercise cardio fields, not explicitly
   whether the overall session timer (Start Workout → Finish) still runs for a cardio-only
   event. This spec assumes it does (for consistency — every session gets a total time,
   cardio exercises themselves just don't have live per-set timers), but this should be
   confirmed — see Section 8.

---

## 7. Non-Goals (this project)

- AI coach consumption of the new set/cardio data (analytics, trend charts, 1RM estimates).
  This project only makes the data exist; using it is future work.
- An authoring UI for `plannedSets` (ramps/pyramids). The schema supports it; nothing here
  builds a way to create them beyond manual DB/JSON edits or the existing coach tool-call
  path (if that path is extended separately).
- Draft/resume UI for interrupted sessions. Autosave-for-crash-safety is recommended
  (Section 6.1) but a "resume where you left off" *experience* is explicitly out of scope
  per the single-sitting requirement.
- Multi-user auth / RLS-per-user. This app is single-user; new tables should follow the
  existing RLS posture set in `phase3_enable_rls.sql`.

---

## 8. Open Questions

Resolve these before or during implementation — don't guess:

1. **Exercise ID stability** — are `Exercise.id` values preserved across edits to an event's
   exercise list, or regenerated? This determines whether `workout_set_logs` can safely key
   on `exercise_id` long-term (Section 3.2, Concern 3).
2. **Autosave cadence** — save on every set edit (debounced), or only at Finish and
   subsequent manual edits? Affects data-loss risk (Section 6.1) vs. write volume.
3. **Reopening an in-progress (not-yet-finished) session** — if autosave is added and a user
   closes the tab mid-workout without hitting Finish, what should "Start Workout" do the next
   time they open that event: resume showing the partially-saved data (even though full
   resumability wasn't requested), or start blank and overwrite? This falls out of the
   autosave decision in #2 and needs an explicit answer.
4. **Cardio session timer** — does the overall Start→Finish elapsed-time metric still apply
   to cardio-only events, or do cardio events skip the total-time metric entirely
   (Section 6, Concern 6)?
5. **Who authors `plannedSets`** — is writing varying per-set planned targets in scope for
   this project (e.g., extending the AI coach's event-creation tool), or purely manual for
   now (Section 6, Concern 2)?
6. **Finish confirmation** — given untouched sets get zero-filled, should tapping "Finish"
   with incomplete exercises show a confirmation ("3 sets unlogged — they'll be recorded as
   0. Finish anyway?"), or finish silently as specified?
7. **Post-finish landing state** — after Finish, does the user land back on the calendar, or
   see a read/edit summary of what was just logged before leaving the page?

---

## 9. Resolutions & Corrections (added at implementation, 2026-07-02)

### Section 8 answers (decided by Shane)

1. **Exercise ID stability** — verified stable. Ids are hand-authored strings in seed data
   (`ub-1`, `mr-2`); the AI coach's `create_event`/`update_event` tools cannot create or
   edit exercises, and no UI path regenerates ids. Safe to key on, with the denormalized
   `exercise_name` snapshot as a hedge.
2. **Autosave** — yes: debounced (800ms) save on every set/cardio edit via the same
   `action: 'save'` upsert, plus a flush on `visibilitychange: hidden`.
3. **Reopening an unfinished session** — resumes: the tracker re-enters pre-populated from
   `workout_set_logs`/`workout_cardio_logs`, timer continuing from the original server
   `started_at`.
4. **Cardio session timer** — runs for every session, cardio-only included; cardio
   exercises just get the structured form instead of per-set rows.
5. **plannedSets authoring** — out of scope for v1. Schema + type + tracker support landed;
   authoring is manual DB/JSON edits until a future project.
6. **Finish confirmation** — yes, but only when unlogged planned sets exist ("N planned
   sets unlogged — recorded as 0. Finish anyway?").
7. **Post-finish landing** — back to the calendar. Reopening the event shows a
   "View Workout" button that re-enters the tracker, fully editable.

### Corrections to Section 1/5 claims

- **`workout_completions` is NOT composite-keyed.** `event_id` alone is the primary key
  (schema.sql). Occurrence identity lives in the expanded `${baseId}__${date}` id
  synthesized by `expandRecurringEvents` — that whole string is what `toggleCompletion`
  writes. The new tables store that same occurrence id in `event_id`, with `event_date`
  as a data column (analytics range scans + defensive uniqueness), matching how
  completions actually work rather than the composite-key convention this spec asserted.
- **The tracker is not a `selectedView` arm.** AppShell force-resets `selectedView` by
  viewport width, which would kick a `'tracker'` view back to the calendar on mobile.
  It is separate state: `CalendarContext.trackingSession` (`START_TRACKING` /
  `STOP_TRACKING`), rendered by AppShell as a full-screen portal above the mobile nav.
- **No endpoint sub-paths.** Vercel file routing maps one file to one path and the
  vercel.json catch-all rewrite swallows `/api/workout-sessions/*`. One endpoint,
  `api/workout-sessions.ts`, discriminated by `body.action: 'start' | 'save' | 'finish'`.
- **Completion at Finish happens client-side**, via a new idempotent
  `setCompletion(id, true)` in ScheduleContext (extracted from `toggleCompletion`, which
  is a genuine toggle and would have *un*completed an already-complete event). A
  server-side completions write would also have left the client's local `completedIds`
  stale until reload.
- **Zero-fill is client-computed, server-guarded**: the client sends `autofillRows` with
  the finish request; the server inserts them with `ignoreDuplicates` on the set-log
  unique key, so a set logged concurrently is never overwritten with zeros.
- **Read path (spec omitted it):** the tracker hydrates by reading the three new tables
  directly with the anon client; the phase4 migration adds SELECT-only RLS policies for
  anon, matching the phase3 posture.

### Delivered artifacts

- `supabase/migrations/phase4_workout_tracking.sql` — **must be run manually** in the
  Supabase SQL editor, same process as phase3.
- `api/workout-sessions.ts` — start / save / finish endpoint (service-role).
- `src/lib/tracking/plan.ts` — pure model builders (planned-set synthesis, hydration,
  zero-fill collection) with unit tests in `src/lib/tracking/__tests__/plan.test.ts`.
- `src/components/tracker/TrackerView.tsx`, `TrackerExercise.tsx` — full-page tracker.
- `PlannedSet` type + `Exercise.plannedSets` in `src/types/workout.ts`; tracking row
  types in `src/lib/supabaseClient.ts`.
- "Start Workout" / "View Workout" button in `WorkoutModal.tsx` (before Mark as
  Complete, per Section 4.1); `trackingSession` state in `CalendarContext.tsx`;
  `setCompletion` in `ScheduleContext.tsx`; tracker styles in `src/styles/app.css`.
