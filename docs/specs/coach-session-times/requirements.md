# Coach corrects a session's recorded times — requirements

## Goal
An athlete who left a session running (a stretch that "took" 20 days) can ask
the coach to fix it, and the coach can: it proposes the corrected start and
finish, the athlete confirms the card, and every total, PR context and review
that reads the duration reads the corrected number. Today the coach can only
change the plan (`update_event`), so it finds the bad number and then tells the
athlete to fix it by hand (2026-11-08, `ext-2026-09-01-stretch`: 1,695,855 s
recorded for a 29-minute plan). Serves Article VI (the numbers are true) and
Article II (the fix is one reach away: the coach that found it), under Article
VII (nothing changes without the athlete).

## Who and when
- The athlete notices a month's time totals are absurd, asks the coach why,
  and wants the coach to fix the session it finds.
- The athlete says "I forgot to stop Tuesday's stretch, it was about 15
  minutes" and expects the coach to correct it.
- An assistant on a write-scoped connector (Claude with the Apex MCP) finds the
  same runaway session through `list_sessions` and fixes it.

## Requirements
- **R1** The in-app coach has a confirm-card write tool, `edit_session_times`,
  that changes a finished, tracked session's `started_at`, `finished_at` and
  `total_duration_seconds`, and the completion row's `duration_minutes`,
  through the same `applyEditTimes` the athlete's own "edit times" uses.
- **R2** The tool takes `finished_at` or `duration_minutes` (exactly one), and
  an optional `started_at`; omitted, the recorded start is kept.
  `duration_minutes` ends the session that many minutes after the start. The
  new duration is computed in code, never by the model.
- **R3** A timestamp without an explicit UTC offset or `Z`, a day that does
  not exist (Feb 30), a duration that is not a positive number of minutes up
  to a week, both or neither of `finished_at` / `duration_minutes`, a finish
  at or before the start (including a duration that rounds to no time), and a
  session with no tracked record each return an instructive refusal and
  change nothing.
- **R4** `applyEditTimes`'s refusals reach the model as the tool result: a
  session still running, one marked complete without logging, one whose time
  came from a synced device, a start more than a day before the workout's
  date, a finish in the future.
- **R5** The confirmation card's label names the workout as its id resolves
  and the date the edit lands on (the occurrence, never a series' anchor
  date), and states every new value the input fixes, in the athlete's time
  zone with the zone named (the web uses the browser's zone; the server uses
  `profiles.timezone`, UTC when unset or unknown): start, finish and duration
  when `started_at` is given; the finish when only `finished_at` is; the
  duration when only `duration_minutes` is. Without `started_at` it says the
  recorded start is kept. The card's minutes round the way the record does,
  and the label never throws.
- **R6** A confirmed edit writes an `event_mutations_log` row stamped
  `triggered_by 'ai'` with the before and after times, so it counts toward the
  daily AI-change cap and appears in Profile → Coach activity.
- **R7** The tool result states the new times and the duration before and
  after, so the coach can report what changed without computing it, and says
  that a review already written for the period keeps its old numbers.
- **R8** A recurring occurrence's session is found from either its occurrence
  id (`base__date`) or its base id plus the date.
- **R9** The MCP connector exposes the same executor as a write tool,
  `edit_session_times`, without the card-only field; a read-only token cannot
  call it.
- **R10** `update_event`'s description says it changes the plan, not what was
  recorded, and points to `edit_session_times`.
- **R11** The coach eval suite has a case where the athlete asks to fix a
  runaway session and the coach calls `edit_session_times` (not
  `update_event`) on the right occurrence and lands the athlete's duration,
  and a control where a planned-length change goes through `update_event`,
  not `edit_session_times`. Both pass, and `eval:gate` passes with no
  regression.

## Out of scope
- Detecting runaway sessions at Finish (asking for the real end time when a
  session has run past some bound). That stops new bad numbers; this feature
  repairs existing ones. Proposed as its own follow-up.
- Giving the in-app coach the athlete's time zone, or local times in
  `get_workout_detail`. Until then the coach is told to use
  `duration_minutes` when it does not know the offset.
- A structured before/after preview under the card (`preview.ts`). The label
  carries the new values; the card's context holds no session rows to diff.
- Editing times on a quick-completed or device-synced session; `applyEditTimes`
  refuses those by design.
- Regenerating a stored review (`reviews.stats`) for the corrected period. A
  review written before the fix keeps its numbers; the result says so.
- The card's duration when only `finished_at` is given: it needs the recorded
  start, which the card's context does not hold. The tool result states it.

## Open questions
- None blocking. Whether the coach should proactively flag runaway sessions it
  sees (without being asked) is a prompt question for the follow-up.
