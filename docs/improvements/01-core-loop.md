# Improvement doc 1 — the core loop: planning and logging

**Date:** 2026-10-13 · **Status:** proposal · **Scope:** web + iOS + API
**Source:** a feature-gap review of the whole repo against the product's own thesis — *plan the
week, log the work, get a straight answer about how it went*, with every number computed in code.

The daily surface is solid for typing sets in. It is weak on everything around the typing, and
two of the gaps break the "numbers are trustworthy" rule the README leads with. Items are ordered
by how often a user hits them. Each has the evidence, the user-facing failure, a proposed fix, and
a rough size (S < 1 day · M 1–3 days · L a workstream).

## 1. Units and bodyweight corrupt tonnage and PRs — **P0 · M**

**Evidence.** Weight is free text. `parseLeadingNumber` reads only the leading number
([src/lib/tracking/records.ts:60](../../src/lib/tracking/records.ts)), so `"62.5 kg"` sums into
tonnage as 62.5 lb, and `"BW"` / `"BW+25"` parse to `null`. `classifySet`
([records.ts:169](../../src/lib/tracking/records.ts)) then routes a bodyweight set to a reps-only
or duration PR — never 1RM — and tonnage counts only `oneRM`-classed sets
([review/stats.ts:305](../../src/lib/review/stats.ts),
[physiology/compute.ts:194](../../src/lib/physiology/compute.ts),
[analytics/engine.ts:316](../../src/lib/analytics/engine.ts)). Units are hard-coded imperial for
sync too ([providers/sync.ts:86](../../api/_lib/providers/sync.ts)).

**User sees.** A weighted pull-up adds zero tonnage and can never earn a 1RM PR. A kg lifter's
every chart is wrong by 2.2×. Nothing warns.

**Fix.**
- Parse a unit suffix (`lb`, `kg`) and normalise to one storage unit; convert on display.
- Add `profiles.weight_unit` (`lb` | `kg`) and a body-weight entry (see doc 2 §6) so `BW` and
  `BW+25` resolve to a number at log time; store the resolved number alongside the raw text.
- Analytics `unitKind: 'weight'` gets a unit picker like distance already has.
- Migration: none needed for free text; one column on `profiles`; a backfill is optional.

## 2. No rest or interval timer — **P0 · M (web) + M (iOS)**

**Evidence.** `restPeriod` renders as static text "Rest 90s"
([TrackerExercise.tsx:278](../../src/components/tracker/TrackerExercise.tsx)). The only clock is
the session elapsed timer ([useWorkoutSession.ts:117](../../src/hooks/useWorkoutSession.ts)).
AMRAP has a time-cap field but no countdown. iOS backlog D-015.

**Fix.** A per-set rest countdown that starts when a set is logged, pre-filled from
`restPeriod`, with +15s / skip, audible/haptic end, and on iOS a Live Activity update so the
Lock Screen shows it. An interval mode (EMOM / Tabata / AMRAP cap) can reuse the same clock
component. No schema change.

## 3. No progression mechanism — **P1 · L**

**Evidence.** No percent-of-1RM prescriptions, no week-over-week increase, no plate math (grep
hits exist only in coach doctrine text). `plannedSets` ramps exist in the type and the tracker
honours them, but nothing can author them and editing a prescription clears them
([EventExerciseEditor.tsx:55](../../src/components/builder/EventExerciseEditor.tsx);
WORKOUT_TRACKING_SPEC.md §9.5). The only aid is last session's values in grey
([plan.ts:298](../../src/lib/tracking/plan.ts)).

**Fix, in order.**
1. Per-set authoring in the exercise editor (ramps, pyramids, top set + back-offs).
2. `%1RM` as a weight syntax (`"80%"`) resolved against the exercise's best estimated 1RM at
   render time — deterministic, so it belongs in `src/lib/`, not the coach.
3. A plate calculator on the tracker's weight field (bar + available plates in profile).
4. Only then, a progression rule on a template ("+5 lb when every set hits target") that the
   coach can also drive. Keep the rule in code; the coach proposes, the rule computes.

## 4. Thin set and session metadata — **P1 · M**

**Evidence.** `workout_set_logs` holds planned/actual weight, reps, duration and nothing else.
No RPE/RIR/tempo, no warm-up or failed flag, no session-level note (per-exercise notes only,
`workout_exercise_notes`). Session duration is `finished_at − started_at` and not editable
([workoutSessions.ts:407](../../api/_lib/handlers/workoutSessions.ts)); the session row is created
the moment the tracker opens ([workoutSessions.ts:222](../../api/_lib/handlers/workoutSessions.ts)),
so opening early or logging yesterday's session today records a wrong duration forever.

**Fix.** One migration: `rpe numeric`, `set_kind text check in ('working','warmup','failed','drop')`
on set logs; `note text`, and editable `started_at`/`finished_at` on sessions (the tracker header
gets a tap-to-edit time). RPE is optional and off by default in the tracker; a profile toggle
turns the column on. Everything downstream (PRs, tonnage, physiology) already filters by
`is_autofilled`; extend that to skip `warmup`.

## 5. Silent data loss on web autosave — **P0 · S**

**Evidence.** The dirty set is cleared *before* the request and the error is swallowed
([useWorkoutSession.ts:189-194](../../src/hooks/useWorkoutSession.ts)). On iOS, marking complete
from the schedule and logging meals still require signal
([ScheduleModel.swift:397](../../ios/Packages/ApexKit/Sources/ApexFeatures/Schedule/ScheduleModel.swift),
D-052) even though the tracker queues offline.

**Fix.** Web: keep the dirty keys until the save resolves, retry with backoff, and surface a
persistent "unsaved — retry" bar on repeated failure (the iOS pattern). iOS: move completion and
meals onto the write queue's outbox lane; both are idempotent upserts already.

## 6. Planning ergonomics — **P1 · M each**

- **No drag to reschedule** in month or week view
  ([EventChip.tsx](../../src/components/calendar/EventChip.tsx),
  [WeekView.tsx:44](../../src/components/calendar/WeekView.tsx)); the date chip in the modal is
  the only path. Drag-to-day in month view, drag-to-time in week view, both calling the existing
  occurrence-move service ([eventInstances.ts:215](../../api/_lib/services/eventInstances.ts)).
- **No duplicate / copy week.** Add "Duplicate to…" on the event modal and "Copy last week" on
  an empty week. Both are `create_event` with a cloned body
  ([template/clone.ts](../../src/lib/template/clone.ts)).
- **"Edit exercises" on a series is always series-wide**
  ([EventExerciseEditor.tsx:288](../../src/components/builder/EventExerciseEditor.tsx)). Offer the
  same *this day / every week* choice "Edit workout" already has; the per-occurrence override
  table exists (phase7).
- **Weekly-only repeat picker** ([builder/repeat.ts:5](../../src/lib/builder/repeat.ts)). The
  engine supports daily and count-based rules; the picker should too.

## 7. No workout history — **P1 · M**

**Evidence.** There is no list or search of past sessions. The library shows an exercise's six
most recent sessions ([library/stats.ts:113](../../src/lib/library/stats.ts)). Template search is
the only title/tag search, and only over templates.

**Fix.** A "History" overlay: reverse-chronological sessions, filter by type/sport/exercise/tag,
free-text title search, tap to open the tracker in view mode. Server side it is one paginated
read over `workout_sessions` joined to events; the MCP `get_session_summaries` already shapes it.

## 8. Climbing is under-served for a climbing-identity app — **P1 · M**

**Evidence.** A pitch logs a single grade stored in the weight column
([tracking/fields.ts:39](../../src/lib/tracking/fields.ts),
[plan.ts:75](../../src/lib/tracking/plan.ts)); `ascentStyle` and `climbStyle` exist on the
prescription but are not logged; climbing never fires a PR; swap and add-exercise exclude
climbing; the analytics `max-grade` measure cannot be grouped.

**Fix.** Log send/attempt/flash/redpoint and attempts per pitch; a climbing PR = hardest clean
send per discipline; a "sends by grade" tile; let the tracker add a pitch mid-session.

## Sequencing

| Order | Item | Why first |
|---|---|---|
| 1 | §5 autosave loss | Data loss, one afternoon |
| 2 | §1 units + BW | Every number depends on it; blocks §3 |
| 3 | §2 rest timer | Most-felt daily gap; no schema |
| 4 | §4 metadata migration | One migration unlocks §3 and doc 2 §7 |
| 5 | §3.1–3.3 progression | The reason to plan in Apex rather than a notebook |
| 6 | §6, §7, §8 | Independent; good parallel lanes |

Each row is one PR; §1, §4 carry a migration and are HELD per CONTRIBUTING.md.
