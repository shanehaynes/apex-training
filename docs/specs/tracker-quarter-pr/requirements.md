# Tracker quarterly PR — requirements

What exists when this feature ships, and why it is worth building.

## Goal
In the workout tracker, a strength exercise's "target" column shows the
athlete's best set of that exercise this calendar quarter instead of the
plan's per-set targets: the number to beat today, read in a glance between
sets. The set's fields (weight, reps, time) show one at a time on the first
row, fading between them, so a narrow column carries the whole set. Shane
asked for it on 2026-11-11. It serves Mission I (it needs no setup: it
appears once a set has been logged this quarter) and VI (the best is
computed in code from logged rows; nothing is estimated for display).

## Who and when
- An athlete opens a strength session mid-quarter and wants to know what
  they did best on this lift lately, without opening history.
- An athlete starts the first session of a new quarter: nothing is logged
  yet, so the plan's targets show as before.

## Requirements
- **R1** For an exercise of category `strength`, the bootstrap carries
  `quarterBest`: the best performed set logged in the calendar quarter of the
  session's date and before that date, as logged text (`weight`, `reps`,
  `duration`, empty when the row left it empty), its `date` and the
  `quarter` (1–4). Every other exercise, and a strength exercise with no
  such set, carries `null`.
- **R2** "Best" follows the record rules: the row's kind is classifySet's
  (weight × reps → estimated 1RM; else duration; else reps), plus a weighted
  hold or carry (weight and time, no reps) ranked by weight then time. A
  weighted row outranks an unweighted one, a hold outranks a bare count, and the higher
  value wins within a kind. Warm-ups, autofills and climbing pitches never
  count. Ties keep the most recent.
- **R3** With a `quarterBest`, the column heading reads "Q<n> PR", the first
  working (non-warm-up) set row's cell shows the best set, and every other
  row's cell is empty.
  The plan's per-set label does not show on that card.
- **R4** The cell shows the set's filled fields one at a time, in the order
  weight, reps, time ("205 lb", "3 reps", "1:30"): each stays for 4 s, fades
  out over 0.5 s, and the next fades in, round and round. A single
  field stays still. With `prefers-reduced-motion: reduce` nothing moves and
  the whole set shows on one line ("205 lb × 3"). A screen reader reads the
  whole set, its quarter and its date once, never the cycling text.
- **R5** Without a `quarterBest` (none this quarter, a non-strength
  exercise, an offline model, a swap this sitting) the card shows the plan's
  targets exactly as before.

## Out of scope
- The iOS tracker. The field reaches iOS in the bootstrap and iOS ignores it
  until its own tracker is changed (docs/ios/MASTER.md).
- Updating the best live as today's sets beat it: it is the best before
  today, the number to beat.
- Any change to PR detection at Finish.

## Open questions
- A prescribed program (percentage loads, per-set reps that differ) loses
  its per-set labels on a card that shows a best; the resolved load still
  ghosts in the weight field. Shane to confirm that trade.
- Calendar quarter or trailing 90 days. Built as the calendar quarter, which
  "quarterly PR" names; early in a quarter there is little to show and the
  plan shows instead. Shane to confirm.
