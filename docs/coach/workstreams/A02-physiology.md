# A02 · Physiology panel

## Goal
A pure module that turns the athlete's last five weeks of measured data into a small,
pre-computed prompt block — weekly HR-zone minutes, an acute:chronic load ratio, weekly
strength tonnage and an HRV trend — plus the server-side fetch that feeds it. Nothing wires
it into the prompt yet (the next wave does); this lane ships the functions, the fetch and
tests.

Why: the coach never sees HR zones, training load, HRV or set-log volume, so it cannot say
"your Z2 volume is down 30% from the base block" or notice a load spike. In the Uphill
Athlete school this panel is the instrument cluster; it matters more than any text.

## Context you need
- Data sources and their shapes (read `src/lib/db/database.types.ts` and
  `src/lib/db/types.ts`):
  - `activity_streams` — one row per synced activity (COROS today). `summary` is JSON with
    scalars such as `sport`, `avgHr`, `maxHr`, `hrZones`, `calories`, `hrv`, `trainingLoad`,
    `vo2max` (`ActivityStreamsRow` in `types.ts`). Find the exact key shapes in the provider
    mapping code (grep `hrZones` and `trainingLoad` under `api/_lib/providers/` and
    `src/lib/sync/`) — do not guess them. The row carries a date or a link to the event.
  - `workout_cardio_logs` — `avg_heart_rate`, `duration_minutes`, `distance`,
    `elevation_gain`, linked to a session/event with a date.
  - `workout_set_logs` — planned vs actual reps/weight per set, linked to a session.
  - `profiles.threshold_hr`, `profiles.max_hr`.
- **Zone definitions already exist.** The analytics engine has an `hr-zone-time` measure
  ("minutes per Z1–Z5 from synced HR streams; needs a threshold or max HR"). Grep
  `hr-zone-time` under `src/lib/analytics/` and reuse its zone boundaries and stream-to-zone
  logic by import. Never define a second zone model.
- Strength tonnage and set classification: `src/lib/review/stats.ts` (tonnage measure) and
  `src/lib/tracking/records.ts` (`classifySet`). Reuse by import.
- Reference for how a server-side fetch degrades gracefully: `blockSummary` in
  `api/_lib/coach/context.ts` (any failure → `null` + `console.warn`, never a failed turn).
  Use the `Admin` type pattern there.
- Everything under `src/lib/physiology/` will be imported from `api/**`, so: relative imports
  with `.js`, no React, no supabase-js, no browser globals.

## Interface contract (the next wave imports exactly this — do not rename)
`src/lib/physiology/index.ts` exports:
- `type PhysiologyInputs` — `{ today: string /* YYYY-MM-DD */, activities: ActivityInput[], cardioLogs: CardioLogInput[], setLogs: SetLogInput[], thresholdHr: number | null, maxHr: number | null }`
  where each `*Input` is the minimal plain shape you need (date, the numbers), defined in
  `src/lib/physiology/types.ts`.
- `computePhysiology(inputs: PhysiologyInputs): PhysiologySummary` — pure. Weeks are
  Monday-start (`date-fns`, `weekStartsOn: 1`), covering the four completed weeks before today's
  week plus the current week. `PhysiologySummary` holds, each optional when its source is
  empty: `zoneMinutesByWeek` (Z1–Z5 per week, from `hrZones` when present, else from cardio
  logs' `avg_heart_rate × duration_minutes` classified with the analytics zone boundaries when
  threshold or max HR exists), `load` (`acute7d`, `chronicWeeklyAvg28d`, `ratio`, from
  `trainingLoad`; fallback: cardio minutes), `tonnageByWeek` (lb, weight × reps of logged
  sets), `hrv` (`mean7d`, `mean28d`, from activity `hrv` values).
- `describePhysiology(summary: PhysiologySummary): string` — the prompt block, `''` when
  every section is absent. Shape (tune the wording, keep the tags and the rule line):
  ```
  <physiology>
  PHYSIOLOGY (last 4 completed weeks + this week; every number is pre-computed):
  Zone minutes Z1/Z2/Z3/Z4/Z5 — W-4: … · W-3: … · W-2: … · W-1: … · this week: …
  Load: acute 7d 412 vs chronic weekly avg 380 (ratio 1.08)
  Strength tonnage by week: …
  HRV: 7d mean 62 ms vs 28d mean 58 ms
  </physiology>
  Cite these numbers; use the read tools for anything older or finer-grained. Never recompute or invent others.
  ```
  Omit any line whose section is absent. No `<` inside the body except the tags.

`api/_lib/coach/physiology.ts` exports:
- `fetchPhysiologyInputs(supabase: Admin, userId: string, todayIso: string): Promise<PhysiologyInputs>`
  — queries the four sources for the window (start of the week four weeks before today's
  week, through today), maps rows to the `*Input` shapes, and on any error returns empty
  arrays with `console.warn('[api/chat] physiology unavailable for the prompt:', message)`.

## Ownership
- You own: new `src/lib/physiology/**` (including `__tests__/`), new
  `api/_lib/coach/physiology.ts`, and its test if the repo has a pattern for stubbing the
  admin client (`api/__tests__/`).
- Do not change: `src/lib/analytics/**`, `src/lib/review/**`, `src/lib/tracking/**` (import
  only; if a boundary or measure is not exported, export nothing yourself — report it under
  OUTSIDE MY OWNERSHIP with the exact symbol), `api/chat.ts`, `api/_lib/coach/context.ts`,
  `src/lib/coach/**`, `api/_lib/mcp/**`, `src/components/**`, `evals/**`, Shared state — never.

## Tests
- Fixture-driven unit tests for each computation: a week with zone data, a week with only
  cardio logs and a threshold HR (fallback path), a week with nothing (section absent), a
  load spike (ratio > 1.3), tonnage from mixed logged/unlogged sets.
- `describePhysiology` returns `''` for an empty summary and never emits a stray `<`.
- Decoupling (Pa:Hr) is **out of scope**; note it under FOLLOW-UPS if you see the streams
  make it easy.
