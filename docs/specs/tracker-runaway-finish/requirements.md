# Runaway sessions stopped at Finish — requirements

What exists when this feature ships, and why it is worth building.

## Goal
A tracked session left running (the athlete forgot Finish, closed the tab,
came back the next day) records its real length instead of the hours or days
the timer ran. When an athlete finishes a session that has run far past its
plan, the tracker asks when it really ended before it records anything,
defaulting to when the last set was logged, with "it really ran this long" one
tap away. Article VI (the numbers are true): one runaway stretch on
2026-09-01 recorded 471 hours and inflates every time total it touches.
Article V (trust the athlete): the athlete's answer wins either way, and the
prompt shows the real numbers. Article II (one reach away): a normal finish
gains no tap. `coach-session-times` (#552) repairs runaways after the fact;
this feature stops new ones.

## Who and when
- An athlete who started a stretch at 9:30 PM, logged the last hold at 9:58,
  forgot Finish, and taps it the next evening: the tracker offers 9:58 PM.
- An athlete back at the gym three weeks later who opens yesterday's-but-really-
  last-month's session and taps Finish: the offered time is three weeks back,
  and the server accepts it.
- An athlete who really did climb for five hours on a one-hour plan: one tap on
  "It ran 5 h" finishes as Apex does today.
- An athlete who finishes a normal session, at any length under the threshold:
  nothing changes.

## Requirements
- **R1** `src/lib/tracking/runawayFinish.ts` decides whether a session is a
  runaway. It is one when its planned length is a positive, finite number of
  minutes and the time since its start is more than 4× that length *and* more
  than 2 hours. Exactly 4× or exactly 2 hours is not a runaway. A missing,
  zero, negative or non-finite plan is never a runaway.
- **R2** The same module suggests a finish: the latest instant a set or cardio
  row was logged that falls after the start and no later than now; with none,
  the start plus the planned length.
- **R3** The `bootstrap` response carries `lastLoggedAt`: the latest
  `updated_at` among the occurrence's set and cardio rows that are not
  autofilled, or `null` when there are none.
- **R4** The `finish` action accepts a client `finishedAt` older than its
  7-day window when the instant is at or after the session's own start. A
  `finishedAt` before both the window and the start still answers 400
  `timestamp-out-of-window`; one inside the window but before the start still
  answers 400 "finishedAt precedes the session start".
- **R5** Web: Finish on a runaway session shows a prompt before anything is
  recorded. It names the time since the start and the planned length, and
  holds a date-and-time field defaulted to R2's suggestion, where the latest
  logged instant is the later of `lastLoggedAt` and any set or cardio edit
  made in this sitting. When the unlogged-sets confirm is due it comes first;
  when the score step is due it comes after.
- **R6** Web: the prompt's primary action sends `finishedAt` = the field's
  instant. The header timer and the summary then show the duration it makes.
  The action is disabled while the field is empty, before the start, or after
  now.
- **R7** Web: the prompt's "It ran …" action finishes exactly as a finish did
  before this feature (no `finishedAt`; the server stamps now), in one tap.
  "Keep going" closes the prompt and records nothing.
- **R8** Web: Finish on a session at or under the threshold shows no prompt,
  and its `finish` request carries no `finishedAt`, as before.
- **R9** Web: a For Time score step after a corrected finish prefills the
  corrected duration, not the time since the start.
- **R10** iOS: ApexCore's port of R1 and R2 passes the same vector file the
  vitest suite for R1 and R2 reads
  (`ios/Packages/ApexCore/Tests/ApexCoreTests/Fixtures/runaway-finish.json`),
  recorded as a D-008 exception in `docs/ios/decisions.md` (D-061).
- **R11** iOS: Finish on a runaway shows the same prompt (R5's content and
  order, with `lastLoggedAt` decoded from the bootstrap and this sitting's
  set edits) and queues the finish with the chosen `finishedAt`. The summary
  duration, the cached session, the Live Activity's end and the Apple Health
  workout all use the chosen finish.
- **R12** iOS: "It ran …" queues the finish stamped now, as before; "Keep
  going" records nothing; under the threshold Finish shows no prompt and
  queues the same payload as before.

## Out of scope
- Repairing sessions already recorded (that is #552's coach tool and the
  tracker's own edit-times form).
- Prompting while the session is still running (a nudge after N hours). Article
  V rules out manufactured urgency, and the moment of Finish is when the
  athlete is present to answer.
- Sessions with no plan: no prompt (R1). Whether they need one is a question
  for the data once strangers use Apex.
- A per-athlete or per-sport threshold.
- Changing the offline write queue's strip-and-retry for `start`.

## Open questions
- None blocking. The threshold rests on one athlete's history (Shane's, the
  only account read; see `plan.md`, Approach). It is two constants in one
  file, and moving them is a one-line PR when strangers' sessions say so.
