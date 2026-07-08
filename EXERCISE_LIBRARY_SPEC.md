# Exercise Library (Normalized Exercise Definitions) — Plan & Spec

**Version:** 1.1
**Date:** 2026-07-08
**Status:** In implementation — all Section 8 questions resolved 2026-07-08 (answers inline)
**Owner:** Shane Haynes
**Implementer:** Fable 5 (via Claude Code)

---

## 0. Purpose of this document

Today every workout event embeds full copies of its exercises in JSONB. "Deep Squat Hold"
exists as ~344 identical copies across events; editing a form cue in one leaves the other
343 stale, and renaming an exercise in one event silently forks its PR history.

This spec introduces **exercise definitions** as first-class entities: one row per movement
("Pistol Squat", "Weighted Dip") owning identity and descriptive metadata, referenced by
workout events. Events keep owning their **prescriptions** (sets/reps/weight for that day).
PRs and history remain **derived** from logs — never stored on the definition.

The governing design rule, settled in discussion on 2026-07-08:

> **Definition owns identity + description (+ optional insert-time defaults); each event
> owns its actual prescription; history stays computed.**

Fields that propagate when edited once: name, category, muscle groups, equipment, image,
technique notes. Fields that must never propagate: sets, reps, weight, duration, rest,
planned sets, instance notes. Fields that are never stored at all: PRs, last performance,
previous metrics (computed client-side from `set_logs` / `cardio_logs`, per existing
convention — deterministic data computed client-side, AI narrates only).

This doc follows the same shape as [WORKOUT_TRACKING_SPEC.md](WORKOUT_TRACKING_SPEC.md):
Section 1 is verified against the current code, not assumed. Section 8 lists genuinely open
questions — resolve those before or during implementation, don't guess.

---

## 1. Current-State Findings (verified 2026-07-08)

- **Exercises are embedded copies, not references.** `workout_events.warmup/exercises/cooldown`
  are JSONB arrays of full `Exercise` objects ([supabase/schema.sql:60-62](supabase/schema.sql#L60-L62)).
  The `Exercise` shape ([src/types/workout.ts:21-34](src/types/workout.ts#L21-L34)) conflates
  definition data (`name`, `category`, `muscleGroups`, `imageUrl`, `notes` — currently
  technique cues), prescription data (`sets`, `reps`, `duration`, `weight`, `restPeriod`,
  `plannedSets`), and has no stable cross-event identity — `id` values like `mr-1` are
  per-event and arbitrary.
- **PR and last-performance history ALREADY follows exercises across events, keyed by name
  string.** [src/lib/tracking/records.ts](src/lib/tracking/records.ts) groups best-ever sets
  by `row.exercise_name`; last-performance prefill in
  [src/lib/tracking/plan.ts:201-217](src/lib/tracking/plan.ts#L201-L217) does the same;
  [src/lib/tracking/sessionRepo.ts:52](src/lib/tracking/sessionRepo.ts#L52) fetches history
  with `.in('exercise_name', names)`. So the "shared PRs / last-completed" UX goal is
  already met — **fragilely**. Renaming "Weighted Dips" → "Weighted Dip" anywhere forks
  history with no warning. That fragility, plus duplicated descriptive fields, is what this
  project fixes.
- **`set_logs` / `cardio_logs` snapshot `exercise_name` at log time** and are append-only
  ([supabase/migrations/phase4_workout_tracking.sql](supabase/migrations/phase4_workout_tracking.sql)).
  The tracker writes `exercise_name: tracked.exercise.name` from the embedded exercise
  ([src/lib/tracking/plan.ts:233](src/lib/tracking/plan.ts#L233)), so whatever name the event
  displays is the name history is keyed by.
- **The migration surface is small.** The seed ([src/data/schedule.json](src/data/schedule.json))
  holds 351 events / 3,513 exercise entries / only **69 distinct names**. Supabase
  `workout_events` (the source of truth; seed is fallback) is expected to be similar. 69
  definitions is a human-reviewable migration, not a fuzzy-matching problem.
- **The coach cannot author exercises today.** The tool registry
  ([src/lib/coach/tools.ts](src/lib/coach/tools.ts)) exposes `create_event` / `update_event` /
  `delete_event`, and `create_event` does not accept an `exercises` array (though
  `CreateEventInput.exercises` exists in [src/lib/schedule/types.ts:18](src/lib/schedule/types.ts#L18)).
  The EXERCISE AUTHORING RULES in [src/lib/coach/prompt.ts:66-70](src/lib/coach/prompt.ts#L66-L70)
  (one movement per entry; unilateral reps say "each side"; holds in duration) currently
  apply to no live tool path. Exercise-level coach tooling is **net-new surface**, which
  means it can be designed definition-aware from day one.
- **There is no exercise-editing UI.** [WorkoutModal.tsx](src/components/modal/WorkoutModal.tsx)
  displays exercises; the tracker logs against them. Nothing edits the embedded arrays from
  the UI. So no existing edit flow breaks.
- **Recurring events are orthogonal.** [src/lib/schedule/expand.ts](src/lib/schedule/expand.ts)
  spreads the base event into virtual occurrences; occurrences inherit whatever the base's
  exercise entries are. Definitions compose with this unchanged.

---

## 2. Data Model

### 2.1 New table: `exercise_definitions`

```sql
CREATE TABLE IF NOT EXISTS exercise_definitions (
  id              TEXT        PRIMARY KEY,   -- stable slug, e.g. 'pistol-squat'
  canonical_name  TEXT        NOT NULL UNIQUE,
  -- Former names + accepted spellings. History matching unions canonical_name
  -- with aliases, so renames never fork PR history (see §2.3).
  aliases         TEXT[]      NOT NULL DEFAULT '{}',
  category        TEXT        NOT NULL CHECK (category IN ('strength','stretch','cardio','skill','mobility')),
  muscle_groups   TEXT[]      NOT NULL DEFAULT '{}',
  equipment       TEXT[]      NOT NULL DEFAULT '{}',
  image_url       TEXT,
  -- Form cues / setup / safety notes. Shared: edit once, every referencing
  -- event displays the update.
  technique_notes TEXT,
  -- Enforces the "reps are per side" authoring convention mechanically.
  is_unilateral   BOOLEAN     NOT NULL DEFAULT false,
  -- Insert-time defaults ONLY: copied into a new event entry when the exercise
  -- is added, then owned by the event. Never resolved live (see §2.2).
  default_sets     INTEGER,
  default_reps     TEXT,
  default_duration TEXT,
  default_weight   TEXT,
  default_rest     TEXT,
  -- Soft archive; referenced definitions are never hard-deleted (see §8).
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

RLS disabled, matching every other table (single-user, no auth yet).

### 2.2 Event entries become reference + prescription

`Exercise` ([src/types/workout.ts](src/types/workout.ts)) gains `definitionId` and splits
its `notes` semantics:

```ts
export interface Exercise {
  id: string;                 // per-event entry id (unchanged)
  definitionId?: string;      // NEW — reference into exercise_definitions
  name: string;               // snapshot of canonical_name at reference time (render fallback)
  category: 'strength' | 'stretch' | 'cardio' | 'skill' | 'mobility';  // snapshot
  // ── Prescription: per-event, NEVER shared ──
  sets?: number;
  reps?: string;
  duration?: string;
  weight?: string;
  restPeriod?: string;
  plannedSets?: PlannedSet[];
  // ── Instance notes: "last set AMRAP today", "drop weight if wrist aches" ──
  // Technique cues move to definition.technique_notes; this field is for
  // day-specific intent only. Post-migration it starts empty (see §4 step 4).
  notes?: string;
  // ── Snapshots retained for render-without-join and definition-missing fallback ──
  imageUrl?: string;
  muscleGroups?: string[];
}
```

**Resolution rule (read path):** when `definitionId` resolves, display name, category,
muscle groups, image, and technique notes come from the definition; the embedded snapshots
are fallback for a missing/deleted definition or a failed fetch. When `definitionId` is
absent (pre-migration data, or deliberately ad-hoc entries), the entry renders exactly as
today — the migration is non-destructive and the read path must not require it.

**Defaults are copied, not referenced.** When an exercise is added to an event (by UI or
coach), `default_*` values prefill the new entry's prescription fields and the definition
is out of the loop from then on. Editing `default_reps` later never touches existing
events — propagating prescriptions would silently rewrite programmed ramps/deloads.

### 2.3 History keying: canonical name + aliases; logs gain a nullable `definition_id`

`set_logs` / `cardio_logs` stay append-only and keep `exercise_name`. No backfill of
existing rows. Per Section 8 Q1 (resolved: yes), both tables gain a **nullable
`definition_id`** column that new rows populate when the tracked entry carries one —
existing rows stay NULL and are matched by name+alias forever.

- **Write path:** the tracker logs the *resolved display name* (the definition's current
  `canonical_name` when the entry has a `definitionId`) and stamps `definition_id` on the
  new row. Since display name and logged name come from the same resolution, new logs are
  always canonical.
- **Read path:** history fetch and grouping match on the union of `canonical_name` and
  `aliases`. `sessionRepo`'s `.in('exercise_name', names)` expands each name to its alias
  set; the grouping maps in `records.ts` / `plan.ts` normalize alias → canonical before
  keying.
- **Rename flow:** renaming a definition sets a new `canonical_name` and automatically
  appends the old name to `aliases`. Old logs keep the old string; alias matching keeps the
  lineage unfroked. This is the whole reason aliases exist — do not skip the auto-append.

This keeps `records.ts`'s per-unit cardio keying (`name|unit`) and Epley 1RM logic
unchanged — only the name-normalization step is new.

---

## 3. API & Client Plumbing

- **`api/exercise-definitions.ts`** (new, mirroring [api/events.ts](api/events.ts)):
  list / create / update (rename handles alias auto-append server-side) / archive.
  Mutations append to `definition_mutations_log` — a parallel table to
  `event_mutations_log` with honest column names (`definition_id`, `definition_name`,
  same `diff` JSONB shape). Resolved in §8 Q2: reuse was rejected because the operation
  CHECK needs altering either way, definition slugs would sit in a column named
  `event_id`, and event-history queries would need to filter out definition rows.
- **ScheduleContext** ([src/context/ScheduleContext.tsx](src/context/ScheduleContext.tsx))
  loads definitions alongside `workout_events` and subscribes to realtime changes on the
  new table the same way it does for events. Expose a `Map<string, ExerciseDefinition>`;
  a pure `resolveExercise(entry, defs)` helper in `src/lib/schedule/` implements §2.2's
  resolution rule so components and the tracker share one code path.
- **Tracker:** `buildTrackingPlan` / session repo take resolved entries, so the only change
  is the alias-aware history fetch + normalization (§2.3).

---

## 4. Migration Plan

Non-destructive throughout: embedded fields are kept as snapshots; a failed or partial
migration leaves the app rendering exactly as before.

1. **Schema migration** (`phase8_exercise_definitions.sql`): create the table + indices.
2. **Extraction script** (one-off, alongside [supabase/seed_events.py](supabase/seed_events.py)):
   read all Supabase `workout_events` JSONB plus `schedule.json`, group entries by
   normalized name (case/whitespace-insensitive), and emit a **review file** proposing one
   definition per distinct name (~69). For each: chosen category / muscle groups / image /
   notes, plus **divergence flags** wherever copies of the same name disagree on a
   definition-tier field, and a list of near-duplicate name pairs (edit distance / shared
   prefix) as merge *suggestions*.
3. **Human review (Shane).** Merge true duplicates by adding aliases; leave genuinely
   distinct movements separate ("Deep Squat" vs "Deep Squat Hold"). **No fuzzy auto-merge**
   — a wrong merge corrupts shared notes and fuses two PR histories; with 69 names, review
   is cheap insurance.
4. **Apply script:** insert definitions; rewrite every event's JSONB entries to add
   `definitionId` (all existing fields kept). Existing embedded `notes` were hoisted into
   `technique_notes` in step 2/3; per-entry `notes` is cleared where it exactly matches the
   hoisted text (it's now shared) and kept where it diverged (it's instance-specific).
   Update `schedule.json` the same way so the fallback path stays consistent.
5. **Read-path code** ships before or with step 4 (resolution rule tolerates both states).

---

## 5. Coach Integration

Net-new tool surface (nothing to retrofit — see §1):

- **System prompt** gains an exercise-library section: the list of canonical names (69 —
  cheap in tokens), so the model references existing definitions by exact name. The
  EXERCISE AUTHORING RULES stay, now backed by real tooling; `is_unilateral` lets the
  executor *validate* the "each side" reps convention instead of trusting prose.
- **New tool `set_event_exercises`** (and `exercises` support on `create_event`): entries
  are `{ name, sets?, reps?, duration?, weight?, plannedSets?, notes? }`. The executor
  resolves each `name` against canonical names + aliases, **exact case-insensitive match
  only**:
  - Match → reference that definition; unset prescription fields prefill from `default_*`.
  - No match → create a new definition (category/muscle groups from tool input or inferred
    fields). The confirmation card MUST surface this: `"Adds 2 new exercises: Copenhagen
    Plank, Zercher Squat"` — the user is the fuzzy matcher of last resort and catches
    near-dupes before they pollute the library.
- **New tool `update_exercise_definition`** for "fix the form cue on pistol squats"-type
  requests. Confirmation card states the blast radius: `"Edits 'Pistol Squat' — affects
  14 workouts"`.
- Definition mutations follow the existing confirm-card → execute → audit-log pattern in
  [src/lib/coach/tools.ts](src/lib/coach/tools.ts) / [api/chat.ts](api/chat.ts).

---

## 6. UI (phased; none of it blocks the data model)

1. **Blast-radius affordance** — anywhere a definition is edited, show "affects N workouts"
   (count references across `workout_events` JSONB). Shared mutable state without visible
   blast radius is how users get surprised; this ships with the first edit surface, not after.
2. **Definition editor** — modal/page editing definition-tier fields only. Prescription
   fields are visibly absent here; that's the UX teaching the two-tier model.
3. **Exercise library page** — all definitions with per-exercise history: last performed,
   est. 1RM trend, PR list. All computable today from `set_logs` via the alias-aware
   grouping; the stable id/canonical name is what makes it worth building.
4. **Exercise picker** — when event-editing UI eventually exists, adding an exercise
   searches canonical names + aliases before offering "create new".

---

## 7. Non-Goals

- **No prescription propagation.** Editing one event's sets/reps/weight never touches
  another event. `default_*` fields are insert-time prefills only.
- **No stored PR / last-performance fields** on definitions or anywhere else. Derived data
  stays derived (existing convention).
- **No `set_logs` / `cardio_logs` backfill.** New rows carry `definition_id` (§2.3);
  existing rows stay NULL and match by name+alias. The append-only history is never
  rewritten.
- **No fuzzy auto-merging** of exercise names, in migration or in coach resolution.
- **No multi-user / definition versioning.** Single-user; live propagation of descriptive
  edits is the desired behavior, not a hazard needing version pinning.

---

## 8. Open Questions — ALL RESOLVED 2026-07-08 (Shane)

1. **`set_logs.definition_id`?** → **RESOLVED: yes.** Nullable `definition_id` added to
   `set_logs` and `cardio_logs`; populated on new rows only, no backfill, name+alias
   matching remains the read-path mechanism for historical rows (§2.3).
2. **Audit table?** → **RESOLVED: separate `definition_mutations_log`.** Reuse rejected —
   the operation CHECK needs altering either way, definition slugs in a column named
   `event_id` lie to readers, and event-history queries would have to filter out
   definition rows (§3).
3. **Archive semantics** → **RESOLVED: confirmed as proposed.** Archiving hides from
   picker/coach list; referencing events keep resolving; hard delete only with zero
   references and no matching logs.
4. **Slug ids** → **RESOLVED: confirmed.** Human-readable slug (`pistol-squat`); rename
   never changes the slug.
5. **Divergent-notes policy** → **RESOLVED: confirmed.** Longest/richest variant becomes
   `technique_notes`; divergent copies keep theirs as instance notes; every such case is
   flagged in the review file.
6. **Coach prompt size** → **RESOLVED: confirmed.** Inline the canonical-name list while
   the library is small; if it exceeds ~150 names, switch to a `search_exercises` tool
   instead of inlining.
