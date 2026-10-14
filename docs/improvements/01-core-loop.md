# Improvement doc 1 — the core loop: planning and logging

**Date:** 2026-10-13 · **Status:** landed except where marked deferred; corrected after the work
**Scope:** web + iOS + API
**Source:** a feature-gap review of the whole repo against the product's own thesis — *plan the
week, log the work, get a straight answer about how it went*, with every number computed in code.

The daily surface was solid for typing sets in and weak on everything around the typing; two of
the gaps broke the "numbers are trustworthy" rule the README leads with. Items are ordered by how
often a user hits them. Each has the evidence, the user-facing failure, what landed, and a size
(S < 1 day · M 1–3 days · L a workstream) corrected to what it took.

This doc was the fleet's input, and some of its evidence was wrong: paths that had moved, a spec
section that does not exist, a HELD list one migration short of the truth, and two false premises
(§6's override table, §7's MCP tool). Evidence below describes the gap as reviewed, cited at
where that code lives on `main` now; corrections are marked *Corrected*.

## 1. Units and bodyweight corrupt tonnage and PRs — **P0 · L** (was M)

**Evidence.** Weight is free text. At review every stat read it through `parseLeadingNumber`
([src/lib/tracking/records.ts:89](../../src/lib/tracking/records.ts)), so `"62.5 kg"` summed as
62.5 lb and `"BW"` / `"BW+25"` parsed to `null`. `classifySet`
([records.ts:205](../../src/lib/tracking/records.ts)) then routed a bodyweight set to a reps-only
or duration PR — never 1RM — and tonnage counts only `oneRM`-classed sets
([review/stats.ts:304](../../src/lib/review/stats.ts),
[physiology/compute.ts:202](../../src/lib/physiology/compute.ts),
[analytics/engine.ts:337](../../src/lib/analytics/engine.ts)). *Corrected:* the fix list named
those three; `classifySet` had twelve call sites, the rest in
[records.ts:231](../../src/lib/tracking/records.ts) (and :243, :255, :419),
[library/stats.ts:59](../../src/lib/library/stats.ts) (and :91),
[mcp/tools/tracking.ts:43](../../api/_lib/mcp/tools/tracking.ts) and
[mcp/tools/schedule.ts:35](../../api/_lib/mcp/tools/schedule.ts). *Corrected:* "units are
hard-coded imperial for sync" is distance and elevation
([providers/sync.ts:86](../../api/_lib/providers/sync.ts)), not weight.

**User sees.** A weighted pull-up added zero tonnage and could never earn a 1RM PR. *Corrected:*
"every chart wrong by 2.2×" overstated it — a kg lifter typing bare numbers got kg values under a
pound label. The real corruption was mixed entries (`"62.5 kg"` beside bare pounds summed as one
unit) and bodyweight sets dropping out. Nothing warned.

**Landed.**
- #417 — phase55 adds `profiles.weight_unit` and `profiles.body_weight_lb`
  ([phase55_core_loop_columns.sql:22](../../supabase/migrations/phase55_core_loop_columns.sql));
  *Corrected:* the doc said "one column on `profiles`, no migration for free text".
- #420 — one parser, `parseWeight` ([weight.ts:55](../../src/lib/tracking/weight.ts)), behind
  `classifySet` ([records.ts:210](../../src/lib/tracking/records.ts)): unit suffixes, `BW±N`
  against the profile's body weight, a bare number in the profile's unit; every caller passes
  the profile's context; Profile sets unit and body weight; analytics gets a weight-unit picker.
- #421 — the tracker saves each new entry with its unit (`withExplicitUnit`,
  [weight.ts:92](../../src/lib/tracking/weight.ts)); Finish PRs and the summary print in the
  profile's unit.

**Rulings.** Weight stays free text with one parser reading it. The unit setting declares what
past bare numbers meant — retroactive by design, said in the UI
([ProfileView.tsx:312](../../src/components/profile/ProfileView.tsx)) — and new entries are
stored with their unit so a later switch cannot reinterpret them.

**Review findings.** Two rounds: PR lines printed unlabelled pounds beside kg; a `unit` tag rode
on pound numbers; history dropped old spellings (`lbs`, `kgs`). Out of them: people-facing text
prints in the user's unit, `displayUnit` ([library/stats.ts:55](../../src/lib/library/stats.ts))
separates the unit a number is in from the unit it is shown in, and the grammar takes the
spelling aliases ([weight.ts:32](../../src/lib/tracking/weight.ts)).

**Deferred.** Coach-owned, one PR under the eval gate: the chart tool's `weight_unit`, the
prompt's "tonnage (lb)", MCP descriptions stating pounds. iOS unit suffixing.

## 2. No rest or interval timer — **P0 · M (web) + M (iOS)**

**Evidence.** `restPeriod` rendered only as static text "Rest 90s"
([TrackerExercise.tsx:471](../../src/components/tracker/TrackerExercise.tsx)). The only clock was
the session elapsed timer ([useWorkoutSession.ts:274](../../src/hooks/useWorkoutSession.ts)).
AMRAP has a time-cap field but no countdown. iOS backlog D-015
([decisions.md:158](../ios/decisions.md)). *Corrected:* the Live Activity already reserved
`restEndsAt` for D-015
([TrackerActivityAttributes.swift:26](../../ios/Packages/ApexKit/Sources/ApexActivity/TrackerActivityAttributes.swift);
[architecture.md:306](../ios/architecture.md)); the iOS half was wiring it, not new attributes.

**Landed.**
- #408 — iOS countdown after a logged set, +15s / skip, haptic at zero, on the Lock Screen
  through `restEndsAt` ([RestTimer.swift:12](../../ios/Packages/ApexCore/Sources/ApexCore/Tracker/RestTimer.swift)).
- #416 — web parity: `useTrackerRestTimer`
  ([TrackerView.tsx:91](../../src/components/tracker/TrackerView.tsx)) from the exercise's rest
  text ([rest.ts:31](../../src/lib/tracking/rest.ts)), with the bar at
  [TrackerView.tsx:224](../../src/components/tracker/TrackerView.tsx).

**Deferred.** Interval mode (EMOM / Tabata / AMRAP cap). D-015 in `docs/ios/decisions.md` still
reads "not now" and needs flipping.

## 3. No progression mechanism — **P1 · L**

**Evidence.** No percent-of-1RM prescriptions, no week-over-week increase, no plate math (grep
hits only in coach doctrine text). `plannedSets` ramps existed in the type and the tracker
honoured them, but nothing could author them and editing a prescription cleared them.
*Corrected:* the editor is [src/components/modal/EventExerciseEditor.tsx](../../src/components/modal/EventExerciseEditor.tsx),
and the spec reference is WORKOUT_TRACKING_SPEC.md §9 item 5
([WORKOUT_TRACKING_SPEC.md:386](../../WORKOUT_TRACKING_SPEC.md)), now amended. The only aid
was last session's values as ghost text ([plan.ts:22](../../src/lib/tracking/plan.ts)).

**Landed.**
1. #411 — per-set authoring on web and iOS: Ramp / Pyramid / Top set + back-offs, rows
   editable after a preset
   ([EventExerciseEditor.tsx:147](../../src/components/modal/EventExerciseEditor.tsx),
   [plannedSets.ts:157](../../src/lib/builder/plannedSets.ts)); a prescription edit no longer
   clears them ([plannedSets.ts:212](../../src/lib/builder/plannedSets.ts)).
2. #423 — `"80%"` as a weight syntax ([percent.ts:27](../../src/lib/tracking/percent.ts),
   `parsePercent`), resolved server-side at bootstrap
   ([trackerSession.ts:233](../../api/_lib/trackerSession.ts), `resolvePercentTargets`,
   [percent.ts:99](../../src/lib/tracking/percent.ts)) to that percentage of the exercise's best
   estimated 1RM (`percentBasis`, [percent.ts:67](../../src/lib/tracking/percent.ts)), rounded
   to the plate step (`resolvePercentWeight`, [percent.ts:44](../../src/lib/tracking/percent.ts))
   and shown as "185 lb (80%)"; the ghost tap enters the resolved load; no history shows the raw
   text; a percentage is display-only and never counts as a lift. The load is resolved only
   under the profile's actual unit and carries its unit end to end; a bodyweight-load best never
   resolves; a mid-session swap clears it (`clearResolvedLoads`,
   [percent.ts:130](../../src/lib/tracking/percent.ts)); only sets of ≤ 12 reps feed the estimate.

**Review findings — %1RM.** Two rounds. Round one: a failed profile read resolved under a guessed
unit (critical — a kg lifter's 80 kg would show as a pound load); a bodyweight 1RM became a bar
load; a swap kept the old lift's load. Round two found nothing critical or major.

**Deferred, HELD for Shane.** §3.3 plate calculator. §3.4 progression rule — a coach tool, so
under the eval gate.

## 4. Thin set and session metadata — **P1 · M**

**Evidence.** `workout_set_logs` held planned/actual weight, reps, duration and nothing else:
no RPE, no warm-up flag, no session-level note (per-exercise notes only,
`workout_exercise_notes`). Session duration is `finished_at − started_at`
([workoutSessions.ts:458](../../api/_lib/handlers/workoutSessions.ts)) and was not editable;
the session row is created when the tracker opens
([workoutSessions.ts:260](../../api/_lib/handlers/workoutSessions.ts)), so opening early or
logging yesterday's session today recorded a wrong duration.

**Landed.**
- #417 — phase55: `rpe`, `is_warmup` on set logs, `note` on sessions
  ([phase55_core_loop_columns.sql:39](../../supabase/migrations/phase55_core_loop_columns.sql),
  :49, :71); `isPerformedSet` ([records.ts:29](../../src/lib/tracking/records.ts)) becomes the
  one rule for "this set counts" (not autofilled, not a warm-up), read by every stat.
  *Corrected:* the proposed `set_kind` enum (working / warmup / failed / drop) became
  `is_warmup` + `rpe`.
- #419 — the tracker: warm-up toggle, RPE behind a device preference, session note, and
  tap-to-edit start and finish (`edit-times`,
  [workoutSessions.ts:687](../../api/_lib/handlers/workoutSessions.ts); bounds in
  [trackerSession.ts:449](../../api/_lib/trackerSession.ts)).

**Deferred.** iOS parity for set metadata.

## 5. Silent data loss on web autosave — **P0 · M (web) + M (iOS)** (was S)

**Evidence.** The dirty set was cleared *before* the request and the error swallowed (the save
path in [useWorkoutSession.ts](../../src/hooks/useWorkoutSession.ts), now replaced by the queue
at :220). On iOS, marking complete from the schedule, quick-complete and logging meals required
signal even though the tracker queued offline. *Corrected:* D-052
([decisions.md:1007](../ios/decisions.md)) is the decision that opened the outbox lane for
builder saves and exercise creates; it did not cover completions or meals, which is the gap.
*Corrected:* web and iOS were separate lanes, and the iOS meal replay needed an API change.

**Landed.**
- #412 — web save queue ([saveQueue.ts:101](../../src/lib/tracking/saveQueue.ts)): keys stay
  dirty until the save lands, backoff with Retry-After, an Unsaved bar.
- #415 — a paused queue has an exit, dispose ends isolation, a failed cancel re-arms autosave.
- #414 — iOS completions, quick-complete and meals go through the outbox
  ([ScheduleModel.swift:676](../../ios/Packages/ApexKit/Sources/ApexFeatures/Schedule/ScheduleModel.swift),
  [MealsModel.swift:389](../../ios/Packages/ApexKit/Sources/ApexFeatures/Meals/MealsModel.swift));
  a replayed meal create answers as landed ([meals.ts:113](../../api/_lib/services/meals.ts)).
- #418 — outbox follow-ups: a gave-up plan-fill counts on its day, let-go keeps a meal or save
  for Fix, 429 give-ups do not count toward Let go.

**Review findings — web autosave.** Three rounds: a permanent 4xx trapped the user; a huge
Retry-After overflowed the timer; cancel dropped edits; one refused row in a batch poisoned its
siblings. The rules that came out: on batch refusal, isolate — resend key by key so only the bad
row is rejected ([saveQueue.ts:206](../../src/lib/tracking/saveQueue.ts)); pause on 401/403
rather than retry ([saveQueue.ts:178](../../src/lib/tracking/saveQueue.ts)); clamp every delay
([saveQueue.ts:61](../../src/lib/tracking/saveQueue.ts)); nothing leaves while a cancel is out
([useWorkoutSession.ts:165](../../src/hooks/useWorkoutSession.ts)).

**Review findings — iOS outbox.** Four rounds: refused meals were discarded; the retry ceiling
dropped ops; a plan-fill was sent after its completion was refused; a gave-up op lost its place;
a deterministic 500 at the head wedged the lane. The rules: nothing is dropped by exhaustion; the
lane is FIFO across gave-up ops — a gave-up head keeps its place and is put back first
([WriteQueue.swift:274](../../ios/Packages/ApexCore/Sources/ApexCore/Cache/WriteQueue.swift));
after three give-ups the user may let go
([WriteQueueStore.swift:224](../../ios/Packages/ApexCore/Sources/ApexCore/Cache/WriteQueueStore.swift)).

## 6. Planning ergonomics — **P1 · M each**

- **No drag to reschedule** in month or week view; the modal's date chip was the only path.
  Landed in #404: drag-to-day ([EventChip.tsx:21](../../src/components/calendar/EventChip.tsx)),
  drag-to-time ([WeekView.tsx:39](../../src/components/calendar/WeekView.tsx)), both through
  `useDragReschedule` ([useDragReschedule.ts:189](../../src/components/calendar/useDragReschedule.ts))
  onto the existing occurrence move
  ([eventInstances.ts:162](../../api/_lib/services/eventInstances.ts)).
- **No duplicate / copy week.** Landed in #406: "Duplicate to…" on the workout modal and "Copy
  last week" on an empty week. *Corrected:* not `create_event` over `template/clone.ts` — a
  copy is `copyBody` ([copy.ts:51](../../src/lib/calendar/copy.ts)) posted to `/api/events`,
  because the draft door auto-completes past dates; the week copy takes one-offs only
  ([copy.ts:40](../../src/lib/calendar/copy.ts)).
- **"Edit exercises" on a series was always series-wide.** Landed in #403: a series occurrence
  asks *this day only / whole series*. *Corrected:* the phase7 override table holds dates and
  times only
  ([phase7_occurrence_overrides.sql:12](../../supabase/migrations/phase7_occurrence_overrides.sql));
  "this day only" is a detach ([exerciseScope.ts:24](../../src/components/modal/exerciseScope.ts),
  [eventInstances.ts:83](../../api/_lib/services/eventInstances.ts)).
- **Weekly-only repeat picker.** Landed in #407, web and iOS: daily rules and "after N times"
  ([repeat.ts:11](../../src/lib/builder/repeat.ts)). *Corrected:* the engine already accepted
  both ([recurrence/validate.ts:4](../../src/lib/recurrence/validate.ts), :24); only the
  picker was missing them.

**Deferred.** A real per-occurrence exercise override. `describeRepeat`
([repeat.ts:129](../../src/lib/builder/repeat.ts)) wired into the coach, under the eval gate.

## 7. No workout history — **P1 · M**

**Evidence.** There was no list or search of past sessions. The library shows an exercise's six
most recent sessions ([library/stats.ts:129](../../src/lib/library/stats.ts)). Template search
was the only title/tag search, and only over templates. *Corrected:* the MCP
`get_session_summaries` ([sessions.ts:35](../../api/_lib/mcp/tools/sessions.ts)) returns coach
write-ups in a date window — it does not list sessions.

**Landed.** #405 — a new `list_sessions` tool, newest first behind a keyset cursor
([sessions.ts:236](../../api/_lib/mcp/tools/sessions.ts)), and a History overlay over it
([HistoryView.tsx:30](../../src/components/history/HistoryView.tsx)).

**Deferred.** Coach access to `list_sessions` — a coach-owned change under the eval gate
([readTools.ts:29](../../api/_lib/coach/readTools.ts)).

## 8. Climbing is under-served for a climbing-identity app — **P1 · M**

**Evidence.** A pitch logged a single grade in the weight column
([tracking/fields.ts:40](../../src/lib/tracking/fields.ts)); `ascentStyle` and `climbStyle`
existed on the prescription but were not logged; climbing never fired a PR; swap and
add-exercise excluded climbing; the analytics `max-grade` measure cannot be grouped
([spec.ts:191](../../src/lib/analytics/spec.ts)). *Corrected:* "5.10a" parsed to 5.1
([records.ts:89](../../src/lib/tracking/records.ts)) and escaped 1RM only because a pitch has no
reps; `parseWeight`'s grammar now rejects it ([weight.ts:32](../../src/lib/tracking/weight.ts)).

**Landed.** #422 — a style picker and attempts per pitch
([plan.ts:33](../../src/lib/tracking/plan.ts)) on phase55's `ascent_style` / `attempts`; a send
record, the hardest clean send per exercise and grade scale
([records.ts:342](../../src/lib/tracking/records.ts)); a pitch can be added mid-session
([TrackerView.tsx:57](../../src/components/tracker/TrackerView.tsx)); swap refuses a change of
logged shape ([trackerSession.ts:601](../../api/_lib/trackerSession.ts)).

**Deferred.** The "sends by grade" measure, parked on `feat/sends-by-grade` because it changes
the coach's chart schema (eval gate). Sends in review/period PRs, `get_prs` and library stats.
iOS climbing controls.

## Sequencing

| Order | Item | Why first | Status |
|---|---|---|---|
| 1 | §5 autosave loss | Data loss | Landed — #412, #415 (web); #414, #418 (iOS) |
| 2 | §1 units + BW | Every number depends on it; blocks §3 | Landed — #417, #420, #421; coach unit text deferred |
| 3 | §2 rest timer | Most-felt daily gap; no schema | Landed — #408 (iOS), #416 (web); interval mode deferred |
| 4 | §4 metadata migration | One migration unlocks §3 and doc 2 §7 | Landed — #417, #419; iOS parity deferred |
| 5 | §3.1–3.3 progression | The reason to plan in Apex rather than a notebook | §3.1 landed — #411; §3.2 landed — #423; §3.3, §3.4 deferred (HELD) |
| 6 | §6, §7, §8 | Independent; good parallel lanes | Landed — #403, #404, #406, #407; #405; #422 |

*Corrected:* not one PR per row, and not two migrations. One migration, phase55 (#417), carried
the columns for §1, §4 and §8; it was the only PR the merge policy HELD, and shipped on Shane's
`shipit` after phase53, phase54 and phase55 were pasted into production. Held back from the
fleet for Shane: §3.3, §3.4, and every coach-owned change (eval gate).

## Lessons

- Three lanes passed `npm run agent:check` locally and failed CI on iOS fixture drift: the local
  gate does not run the stack-backed integration suite that regenerates and checks
  `ios/Fixtures/`.
- Production was found two migrations behind `main` (phase53, phase54) during this work.
