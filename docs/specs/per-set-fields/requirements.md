# Per-set fields — requirements

What exists when this feature ships, and why it is worth building.

## Goal
An athlete planning a workout can give each set its own value for every
field the exercise card shows (weight, reps, duration and rest), not only
the fields the set-level prescription already names, and the tracker plans
and times each set by those values. Shane asked for it on 2026-11-17, from
the iOS exercise editor: an Overhead Squat with only a weight set showed a
per-set table with one Weight column and no way to vary reps or rest by
set. It serves Mission III (training varies; a top set, back-offs and
longer rest before the heavy set are each set's own shape) and II (the
column is one tap away on the card, not a detour through the base fields).

## Who and when
- An athlete plans 5 × 65 lb overhead squats and wants 8, 8, 6, 6, 4 reps:
  they open Per-set targets, add the Reps column and type the reps.
- An athlete wants 3 minutes of rest before a top set and 90 s otherwise.
- An athlete who authored a weight ramp later changes the set-level reps
  from 5 to 3 and expects every set to follow, since no set said otherwise.
- An athlete in the tracker finishes the set before the top set and the
  rest timer starts that set's 3 minutes, not the exercise's 90 s.

## Requirements
- **R1** Rest is a per-set field: `PlannedSet.targetRest` (free text, like
  `restPeriod`) on web and iOS, a Rest column in the per-set table on both,
  and the presets can fill it.
- **R2** Every field (weight, reps, duration, rest) can be added to the
  per-set table on web and iOS, whether or not the set-level prescription
  names it; a column that holds a value stays shown when the editor reopens.
- **R3** A per-set cell holds an override. An empty cell shows the
  set-level value it follows, the tracker resolves it to that value
  (`resolvePlannedSets`), and a set-level edit reaches every set that has
  not overridden that field. A table with no override is not stored.
- **R4** In the tracker (web and iOS), a committed set starts the rest its
  own row gives, else the exercise's `restPeriod`.
- **R5** The tracker card's rest line (web and iOS) reads one value when
  every planned set rests the same, else each run of equal rests in set
  order ("2 min ×3 · 90s"). The values are the athlete's own text.
- **R6** The iOS event sheet's per-set line shows each set with the values
  it inherits filled in.

## Out of scope
- The coach and the MCP tools reading or writing per-set targets, and
  `set_event_exercises` keeping a table it does not restate (M2's brief).
- Showing per-set targets on a strength card that shows this quarter's best
  (#564's open question, Shane's call).
- Per-set fields beyond the card's four (RPE, tempo, distance).

## Open questions
- Rows authored before this change restate the base in every cell, so a
  base edit does not reach them until the cell is cleared. Built as is: no
  rewrite of stored data. Shane to confirm.
- A row that cleared a field the base names used to mean "no target"; it
  now follows the base. Built that way (R3); Shane to confirm.
