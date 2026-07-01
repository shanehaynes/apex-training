# Recurrence & ICS Engine — Plan & Spec

**Version:** 1.0
**Date:** 2026-07-01
**Status:** Draft — ready for implementation
**Owner:** Shane Haynes
**Implementer:** Fable 5 (via Claude Code)

---

## 0. Purpose of this document

This is a handoff spec for a self-contained engineering project inside the Apex Training
codebase: replace the app's ad-hoc, twice-duplicated recurrence logic with a single,
correct, spec-compliant recurrence engine, and use it to fix a set of real bugs in the
ICS calendar feed. Everything in Section 1 is verified against the current code, not
hypothetical.

This doc is meant to be handed to an agent with no other context. It should not need to
ask clarifying questions to get started — where a judgment call was made, it's recorded
in Section 3 with the reasoning, and any genuinely open questions are called out in
Section 10.

---

## 1. Current-State Findings (why this project exists)

The recurrence logic exists **twice**, independently, and has already drifted:

- **Frontend:** `expandRecurringEvents()` in [src/context/ScheduleContext.tsx:15-49](src/context/ScheduleContext.tsx#L15-L49)
- **Backend:** the `recurringCoverage` block in [api/calendar-feed.ts:74-87](api/calendar-feed.ts#L74-L87)

Concrete bugs, verified in the current code:

1. **Only `frequency === 'daily'` is ever expanded.** `WorkoutEvent.recurringPattern.frequency`
   is typed as `'daily' | 'weekly' | 'custom'` ([src/types/workout.ts](src/types/workout.ts)),
   and `recurring_days` (`INTEGER[]`, 0=Sun…6=Sat) exists specifically to support `weekly`
   ([supabase/schema.sql:65-66](supabase/schema.sql#L65-L66)). But
   `expandRecurringEvents` hard-codes `base.recurringPattern?.frequency !== 'daily'` as a skip
   condition ([ScheduleContext.tsx:28](src/context/ScheduleContext.tsx#L28)) — `weekly` and
   `custom` are schema-legal and type-legal but produce **zero** expanded occurrences. The
   `recurring_days` column is written and read but never consumed by any expansion logic —
   dead plumbing.

2. **The backend's dedup mirrors the same daily-only assumption**, independently
   ([api/calendar-feed.ts:78](api/calendar-feed.ts#L78): `ev.recurring_frequency !== 'daily'`).
   The two implementations are not shared code — they're two hand-written approximations of
   the same concept that happen to agree today only because no weekly/custom event has ever
   existed in real data.

3. **`FREQ=CUSTOM` would be emitted as a literal RRULE token** if a `custom`-frequency row
   ever existed ([api/calendar-feed.ts:144](api/calendar-feed.ts#L144):
   `` `FREQ=${ev.recurring_frequency.toUpperCase()}` ``) — `CUSTOM` is not a valid iCalendar
   `FREQ` value per RFC 5545 §3.3.10. Any calendar client parsing that feed would reject or
   mis-handle the event.

4. **The ICS feed ignores deleted instances entirely.** There's a `recurring_exceptions`
   table (`event_id`, `skipped_date`) that the frontend correctly consults
   ([ScheduleContext.tsx:198-205](src/context/ScheduleContext.tsx#L198-L205)) via
   `deleteEventInstance()` ([ScheduleContext.tsx:418-430](src/context/ScheduleContext.tsx#L418-L430)).
   `api/calendar-feed.ts` never queries this table, so a workout the user explicitly deleted
   from one occurrence (e.g. "skip climbing this Tuesday") still appears in the exported
   `.ics` feed subscribed to by a phone/desktop calendar app. RFC 5545 `EXDATE` is the
   correct mechanism and is currently unused.

5. **Dedup is keyed by workout `type`, not by the specific recurring series.** Both
   `existingDatesPerType` ([ScheduleContext.tsx:19-23](src/context/ScheduleContext.tsx#L19-L23))
   and `recurringCoverage` ([calendar-feed.ts:76-87](api/calendar-feed.ts#L76-L87)) key
   coverage by `event.type` (e.g. `'stretching'`), not by the recurring event's own `id`. If
   a one-off event happens to share a `type` with an unrelated recurring series on the same
   date, expansion of the real recurring occurrence is silently suppressed. This is latent —
   it just hasn't been hit yet.

6. **No UI path creates a recurring event at all.** `createEvent()` in
   `ScheduleContext.tsx` hard-codes `isRecurring: false`
   ([ScheduleContext.tsx:356](src/context/ScheduleContext.tsx#L356)). Every recurring event
   in the system today was seeded directly into Postgres/`schedule.json`. This spec does not
   require building that UI (see Non-Goals), but the engine must be correct for the patterns
   that already exist in seed data (daily, with `UNTIL`).

7. **Time is deliberately floating, not timezone-aware, and must stay that way.** Commit
   `fb62d6a` ("Use floating times in ICS feed so events display in device local timezone")
   already fixed a class of bug where absolute/`Z`-suffixed timestamps displayed at the
   wrong wall-clock time depending on device timezone. There is no `TZID`, no `Intl`, no
   timezone concept anywhere in `src/` or `api/` (verified by search). **This is intentional
   and must not be undone** — see Constraint in §3.

Three separate commits (`b2f8753`, `08b0092`, `fb62d6a`) already went into patching symptoms
of this (AM/PM parsing, duplicate-row dedup, floating time). That pattern — recurring
one-off fixes to hand-rolled date logic — is exactly what a real, tested recurrence engine
should end.

---

## 2. Goals

- One shared, pure, dependency-free recurrence module, imported by **both** the frontend
  (`ScheduleContext`) and the backend (`api/calendar-feed.ts`) — no more duplicated logic.
- Support `DAILY` and `WEEKLY` (with `BYDAY`) recurrence end-to-end: data model → expansion
  → ICS export, correctly. This closes the gap in Finding #1 for the schema's actual
  documented intent (`recurring_days` exists for exactly this).
- Add `MONTHLY` (by day-of-month only, e.g. "the 1st of every month") as a fully supported,
  tested pattern.
- Correct `EXDATE` handling: skipped instances (`recurring_exceptions`) must be excluded
  from both in-app expansion and the exported ICS feed.
- Dedup/coverage logic scoped per recurring series (`event_id`), not per workout `type`.
- A real RRULE parser + serializer, validated against RFC 5545 §3.8.5.3 example vectors,
  so the engine is provably spec-compliant rather than "works for our current data."
- Full unit test coverage, including DST-adjacent dates, month-end edge cases (e.g. `BYMONTHDAY=31` in a 30-day month), and leap years.

## 3. Non-Goals / Out of Scope

- **No external RRULE library** (e.g. `rrule`, `ical.js`). Building the parser/expander
  by hand is the point of this project — pulling in a library would make this a config
  exercise instead of an engineering one. (If a future maintainer wants to swap in a
  library later, this spec's test vectors become the acceptance suite for that swap.)
- **No calendar import feature.** The parser is built for correctness/round-tripping and
  future-proofing, not because there's a current "import an external .ics" feature. Do not
  build an import UI.
- **No recurrence-picker UI.** Nothing today creates weekly/monthly recurring events through
  the app UI (Finding #6). This spec covers the engine and its two existing consumers only.
  A creation UI is a reasonable follow-up project, not part of this one.
- **No true timezone support / `VTIMEZONE`.** Keep floating local time. Do not add `TZID` or
  `Z`-suffixed datetimes to ICS output — that regresses the fix in `fb62d6a`.
- **No `YEARLY` frequency, `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `RDATE`, or ordinal `BYDAY`**
  (e.g. "2nd Tuesday of the month"). None of these have a real use case in this app's data.
  Scope is `DAILY` / `WEEKLY` / `MONTHLY` with `INTERVAL`, `BYDAY` (weekly only, plain
  weekday tokens), `BYMONTHDAY` (monthly only), `COUNT`, `UNTIL`, `EXDATE`.
- **No auth/RLS changes.** Unrelated to this project.

## 4. RFC 5545 Subset Supported

| Property | Supported values | Notes |
|---|---|---|
| `FREQ` | `DAILY`, `WEEKLY`, `MONTHLY` | `YEARLY` and others rejected by validator |
| `INTERVAL` | positive integer, default 1 | e.g. every 2 weeks |
| `BYDAY` | `SU,MO,TU,WE,TH,FR,SA` (comma list, no ordinal prefix) | valid with `WEEKLY` only |
| `BYMONTHDAY` | 1–31 (positive only) | valid with `MONTHLY` only; if the month is shorter than the day, that month's occurrence is skipped (do not clamp or roll over — see test vectors in §8) |
| `COUNT` | positive integer | mutually exclusive with `UNTIL` — validator must reject both present |
| `UNTIL` | `YYYYMMDD` or `YYYYMMDDTHHMMSS` (floating, no `Z`) | inclusive per RFC 5545 |
| `EXDATE` | one or more `YYYYMMDD` dates | sourced from `recurring_exceptions` table, not embedded in the stored rule string |

Anything outside this table should cause the parser to throw a descriptive error, not
silently ignore the unsupported part.

## 5. Design Decisions

**Canonical rule storage: a single RRULE string, not separate frequency/days/end-date columns.**
Add a new column, `recurrence_rule TEXT` (nullable), storing the literal RRULE value string
(e.g. `FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231`) with no `RRULE:` prefix. This becomes the
single source of truth for a recurring event's pattern. Reasons:
- The existing `recurring_frequency` / `recurring_days` / `recurring_end_date` triad can't
  express `INTERVAL`, `COUNT`, or `BYMONTHDAY` without adding a new column per property —
  it doesn't scale and it's already semantically incomplete (`custom` means nothing).
- A single canonical string is trivially round-trippable to/from the ICS `RRULE:` line —
  the export code becomes `` `RRULE:${row.recurrence_rule}` `` with zero transformation.
- It forces validation to happen once, at write time (via the parser), rather than being
  re-interpreted ad hoc by each consumer.

Keep `recurring_frequency`, `recurring_days`, `recurring_end_date` columns in place
(deprecated, unused by new code) rather than dropping them in this project — see migration
plan in §6. Don't couple a schema-drop to this feature work.

**Dedup/coverage keyed by `(event_id, date)`, not `(type, date)`.** Fixes Finding #5.

**EXDATE is not stored inside `recurrence_rule`.** It's derived at expansion time from the
`recurring_exceptions` table, per occurrence. Keeps the stored rule string reusable
independent of which instances a given user has since deleted.

**Constraint carried forward from `fb62d6a`: all datetimes stay floating.** `UNTIL` values
and expanded occurrence dates/times must never gain a `Z` suffix or `TZID` parameter. The
engine operates purely on calendar dates (Gregorian calendar arithmetic: add N days / N
weeks / N months), never on absolute instants — so DST transitions are a non-issue by
construction, not something requiring special-case handling. Test vectors in §8 confirm
this explicitly so a future change doesn't reintroduce the bug `fb62d6a` fixed.

## 6. Data Model Changes

New migration file: `supabase/migrations/phase3_recurrence_rule.sql`

```sql
ALTER TABLE workout_events ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;

-- Backfill existing daily-recurring rows (the only pattern that has ever been used in
-- real data) into the new canonical column.
UPDATE workout_events
SET recurrence_rule = 'FREQ=DAILY' ||
  CASE WHEN recurring_end_date IS NOT NULL
       THEN ';UNTIL=' || to_char(recurring_end_date, 'YYYYMMDD')
       ELSE '' END
WHERE is_recurring = true
  AND recurring_frequency = 'daily'
  AND recurrence_rule IS NULL;
```

`recurring_frequency`, `recurring_days`, `recurring_end_date` are left in place, unused by
new code, clearly marked deprecated in a comment. Do not write a destructive migration that
drops them.

`src/types/workout.ts`: add `recurrenceRule?: string` to `WorkoutEvent`. Leave
`recurringPattern` in place for now (still read by `rowToEvent`/`eventToRow` for
backward-compat display) but new expansion logic reads `recurrenceRule`, not
`recurringPattern`.

`src/lib/supabaseClient.ts`: add `recurrence_rule: string | null` to `WorkoutEventRow`.

## 7. Module Architecture

New directory: `src/lib/recurrence/` — plain TypeScript, no DOM/Node APIs, no React, so it's
importable unchanged from both the Vite frontend bundle and the Vercel serverless function
(`api/calendar-feed.ts` already imports sibling modules the same way `@supabase/supabase-js`
is imported today; no new build config needed).

```
src/lib/recurrence/
├── types.ts       # RecurrenceRule interface + Weekday enum
├── parse.ts        # parseRRule(ruleString: string): RecurrenceRule
├── serialize.ts     # serializeRRule(rule: RecurrenceRule): string
├── expand.ts        # expandRecurrence(...): string[]
├── validate.ts       # validateRRule(rule: RecurrenceRule): void — throws on spec violations
└── index.ts          # re-exports
```

### `types.ts`

```typescript
export type Weekday = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;          // default 1
  byDay?: Weekday[];         // WEEKLY only
  byMonthDay?: number[];     // MONTHLY only, 1-31
  count?: number;            // mutually exclusive with `until`
  until?: string;            // 'YYYY-MM-DD', inclusive, floating
}
```

### `parse.ts`

```typescript
export function parseRRule(ruleString: string): RecurrenceRule
```
Parses a semicolon-delimited `KEY=VALUE` string (the RRULE value, no `RRULE:` prefix).
Must reject: unknown keys, unsupported `FREQ` values, both `COUNT` and `UNTIL` present,
`BYDAY` outside `WEEKLY`, `BYMONTHDAY` outside `MONTHLY`, malformed date values. Errors
should be descriptive (`Error` with a message naming the offending token), not generic.

### `serialize.ts`

```typescript
export function serializeRRule(rule: RecurrenceRule): string
```
Inverse of `parseRRule`. `serializeRRule(parseRRule(s)) === s` must hold for every valid
input in canonical key order (`FREQ;INTERVAL;BYDAY;BYMONTHDAY;COUNT;UNTIL` — omit
`INTERVAL` when it's 1, to match how these rules are hand-authored in seed data today).

### `expand.ts`

```typescript
export function expandRecurrence(
  rule: RecurrenceRule,
  dtstart: string,        // 'YYYY-MM-DD', the base event's own date (first occurrence)
  exdates: Set<string>,   // 'YYYY-MM-DD' set, occurrences to omit
  rangeEnd?: string,      // 'YYYY-MM-DD' cap for open-ended/COUNT rules when only a window is needed (e.g. ICS export doesn't need to materialize years of dates)
): string[]               // sorted 'YYYY-MM-DD' dates, NOT including dtstart itself
```
Returns only the *generated* occurrence dates after `dtstart` — callers are responsible
for including the base event separately, matching the existing convention in
`expandRecurringEvents` (`expanded = [...rawEvents]` then push generated occurrences).
Must terminate (respect `count`/`until`, or `rangeEnd` as a hard cap for opinion-free
`FREQ=DAILY` rules with no `UNTIL`/`COUNT` — should not happen given `validate.ts`, but the
cap is a defensive backstop against infinite loops).

### `validate.ts`

```typescript
export function validateRRule(rule: RecurrenceRule): void  // throws on invalid combos
```
Called by `parse.ts` internally, and exported separately so callers constructing a
`RecurrenceRule` programmatically (not from a string) can validate it too.

## 8. Test Plan

New test file(s) — this repo has **no test runner configured today**; add one
(`vitest` is the natural fit given Vite is already the build tool — install
`vitest` as a devDependency, add a `"test": "vitest run"` script, no other test
infra exists to conflict with).

`src/lib/recurrence/__tests__/`:

- **RFC 5545 reference vectors** (from §3.8.5.3 of the spec, adapted to this subset):
  - `FREQ=DAILY;COUNT=10` from `2026-09-02` → 10 consecutive dates.
  - `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=8` → every-other-week Tue/Thu pattern.
  - `FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6` → the 1st of 6 consecutive months.
- **Month-end edge case:** `FREQ=MONTHLY;BYMONTHDAY=31` starting near a 30-day or
  28/29-day month — February, April, June, etc. must be **skipped entirely** for that
  occurrence, not clamped to the last day of the month. Assert the exact skip behavior.
- **Leap year:** `FREQ=MONTHLY;BYMONTHDAY=29` spanning Feb of a leap year and Feb of a
  non-leap year in the same expansion window — non-leap Feb is skipped.
- **DST-adjacent dates:** expand a `FREQ=DAILY` rule across a spring-forward and a
  fall-back date (use real US DST transition dates for 2026/2027) and assert the returned
  date strings are exactly consecutive calendar dates with no duplicate/skipped date and no
  time-of-day drift — proving the floating/calendar-arithmetic model (§5 constraint) holds.
- **`COUNT`/`UNTIL` mutual exclusivity:** `parseRRule` must throw if both are present.
- **Unsupported tokens:** `FREQ=YEARLY`, `BYSETPOS=...`, ordinal `BYDAY` (`2TU`) must all
  throw from `parseRRule`.
- **Round-trip:** for every valid vector above, `serializeRRule(parseRRule(x)) === x`.
- **EXDATE integration:** expand a `WEEKLY` rule across 4 weeks with 1 date in `exdates` —
  assert exactly 3 occurrences returned, the excluded date absent.
- **Series-scoped dedup (regression test for Finding #5):** two events of the same `type`,
  one recurring `DAILY` and one unrelated one-off event on a date that would otherwise be a
  generated occurrence — assert the recurring series still generates its occurrence
  correctly (i.e. dedup is per `event_id`, not per `type`).

Also add integration-level tests (or, if `vitest` + jsdom setup is too heavy for this
project's scope, targeted unit tests on the pure logic extracted from these consumers):

- `ScheduleContext`'s replacement expansion path produces identical output to the current
  `expandRecurringEvents` for all `DAILY` rules already in `schedule.json` (regression
  safety net before behavior changes for `WEEKLY`/`MONTHLY`).
- `api/calendar-feed.ts`'s ICS output, for a `WEEKLY` recurring event with one
  `recurring_exceptions` row, contains an `EXDATE` line matching that skipped date, and the
  overall VEVENT count for a fixed test dataset matches the expected count exactly (no
  duplicate rows, no missing `EXDATE`).

## 9. Implementation Chunks

| Chunk | Name | Depends on | Deliverable |
|---|---|---|---|
| A | Engine core | — | `src/lib/recurrence/{types,parse,serialize,validate,expand}.ts` + full unit test suite from §8, all passing. No consumer changes yet. |
| B | Test runner setup | — (parallel with A) | `vitest` installed, `npm run test` wired up, CI-less for now (no `.github` exists — out of scope to add CI here unless asked) |
| C | Schema migration | — (parallel with A/B) | `supabase/migrations/phase3_recurrence_rule.sql` per §6, applied to the project's Supabase instance, `WorkoutEventRow`/`WorkoutEvent` types updated |
| D | Frontend integration | A, C | `ScheduleContext.tsx`'s `expandRecurringEvents` rewritten to call `expandRecurrence`, reading `recurrenceRule` + `recurring_exceptions`; dedup fixed to be per-`event_id` (Finding #5); regression test from §8 passing against real `schedule.json` data |
| E | Backend integration | A, C | `api/calendar-feed.ts` rewritten to call the shared module for both `RRULE:` line generation (`serializeRRule`, fixing Finding #3's `FREQ=CUSTOM` bug) and `EXDATE:` line generation from `recurring_exceptions` (fixing Finding #4); the hand-rolled `recurringCoverage` dedup block replaced with per-`event_id` logic (Finding #2/#5) |
| F | Manual verification | D, E | Subscribe a real calendar client (Apple Calendar / Google Calendar) to the `/api/calendar-feed` URL against a test Supabase project seeded with a `WEEKLY` recurring event that has one skipped instance; confirm the skipped instance does not appear and the pattern matches expectations |

Chunks A–C can run in parallel. D and E both depend on A+C but are independent of each
other. F is last.

## 10. Open Questions (for the human, not the implementer to guess)

1. Is a live Supabase project available for the implementer to actually run migration C and
   do the manual verification in Chunk F, or should F be validated against local
   Postgres / a Supabase branch only?
2. Should `MONTHLY` support be included in this pass, or deferred? It's scoped and speced
   above (§4, §8) but nothing in current seed data uses it — daily and weekly are the
   confirmed real needs (weekly per the dead `recurring_days` column). Recommend: include
   it, since the engine's `expand.ts` internal structure is nearly identical in cost across
   the three frequencies and it's already fully speced — but flagging in case it should be
   cut to shrink the handoff.

## 11. Acceptance Criteria

- [ ] `src/lib/recurrence/` exists, fully unit tested per §8, all tests passing.
- [ ] `ScheduleContext.tsx` and `api/calendar-feed.ts` both import from `src/lib/recurrence`
      and contain no independent recurrence-expansion or RRULE-string-building logic.
- [ ] A `WEEKLY` recurring event with `BYDAY` correctly expands in-app (calendar views) and
      in the exported `.ics` feed.
- [ ] A deleted single instance (`recurring_exceptions` row) is absent from both the in-app
      calendar and the exported `.ics` feed.
- [ ] No `FREQ=CUSTOM` or other invalid RRULE token can be emitted — `custom` frequency
      is either fully supported or rejected at write time, not silently mis-serialized.
- [ ] All exported ICS datetimes remain floating (no `Z`, no `TZID`) — confirmed by a test
      asserting the raw ICS output string contains neither.
- [ ] Existing `schedule.json`/seeded `DAILY` recurring events (nightly stretches, etc.)
      render identically before and after this change (regression-tested, not just eyeballed).
