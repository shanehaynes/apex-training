# Tracker quarterly PR — plan

**Owns:** `src/lib/tracking/records.ts` (the quarterly-best section),
`src/lib/tracking/quarterBest.ts`, `src/components/tracker/QuarterPrTicker.tsx`, `src/components/tracker/quarterPrTiming.ts`,
`src/styles/quarter-pr.css`, the target column in
`src/components/tracker/TrackerExercise.tsx`, `quarterBest` on
`TrackedExercise` (`src/lib/tracking/plan.ts`), the bootstrap in
`api/_lib/trackerSession.ts`, the four `ios/Fixtures/bootstrap*.json`.
**Forbidden:** gate-protected paths, `src/styles/app.css`, the iOS app.
**Depends on:** none
**Status:** in review (branch `claude/project-thread-19at5q`)

## Approach
The server already loads every prior set of the session's movements for the
shadows and percentage targets, so the bootstrap computes the quarterly best
from that same history (`attachQuarterBests`, pure, in `records.ts`) under the
athlete's weight context, and sends it on each tracked exercise. The web
formats it (`quarterBest.ts`) and `QuarterPrTicker` cycles it with an opacity
transition; only opacity moves, so the row never reflows. iOS decodes the
bootstrap with Codable, which ignores the new key. No `TECHSTACK.md` row is
touched.

## Milestones

### M1 — Quarterly best in the tracker
Delivers: R1, R2, R3, R4, R5
- [x] The bootstrap sets `quarterBest` per R1 and R2, and the iOS bootstrap fixtures carry it.
- [x] The tracker shows it per R3 and R4, and falls back per R5.

## Decisions
- Calendar quarter of the session's date, not trailing 90 days: the words "quarterly PR". Open for Shane.
- Before the session's date only: the number to beat, the same history the shadows read.
- Only category `strength`: a pitch's column is its grade and mobility keeps its prescription.
- No best this quarter keeps the plan's targets, rather than an empty column: a new quarter's first session still has its prescription.
- Every set row but the first shows an empty cell, keeping the inputs aligned; an extra set loses its "extra" label on such a card (its remove button still marks it).
- Dwell 4 s, fade 0.5 s each way; reduced motion shows the whole set still, since text changing every few seconds is motion too.
- A swap clears the best for the sitting: it was the old movement's.
- The best ranks under the profile's weight context, open session or finished, read once per bootstrap whenever a strength exercise has a row this quarter (or a percentage target, or the session is finished). A bare "100" is 100 kg for a kg lifter and "BW+45" needs body weight, so the pounds default would show one PR mid-workout and another after Finish (Codex review on #564). An open session with nothing to rank still adds no read; tracker-percent.test.ts now pins that case, with last quarter's history.

## Session log
- 2026-11-11 · M1 built on `claude/project-thread-19at5q`. Not verified here: Playwright (no browser in this sandbox; CI runs the mock spec) and the live-stack fixture values (no Docker; the fixtures were written by hand from the integration scenario, and CI's full job checks them byte for byte).

## Learned

## Next brief
If Shane wants it on iPhone: port the target column change to the iOS
tracker (`ios/`, start at docs/ios/MASTER.md). Decode `quarterBest` on
`TrackedExercise` in ApexCore, add `QuarterBest` formatting mirroring
`src/lib/tracking/quarterBest.ts` (fields, summary, heading, description),
and in the set table show "Q<n> PR" with the cycling value on the first row
(4 s dwell, 0.5 s cross-fade, still under Reduce Motion), falling back to the
planned labels when it is null. Prove it with a snapshot test per state.
