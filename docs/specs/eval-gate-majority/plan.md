# Eval gate on majorities — plan

**Owns:** `evals/gate.ts`, `evals/src/compare.ts`, `evals/__tests__/gate.test.ts`,
`evals/__tests__/compare.test.ts`, `evals/__tests__/fixtures/`,
`evals/baseline/claude-sonnet-5.json`, `evals/gate/attestation.json`,
`evals/results/` (the source runs and the gate run), `evals/README.md`,
`evals/baseline/README.md`, this folder.
**Forbidden:** the coach (`src/lib/coach/`, `api/_lib/coach/`, `api/chat.ts`),
`evals/cases/`, the checkers and judges in `evals/src/`, and
`scripts/merge-policy.mjs`.
**Depends on:** none. PR #552 and #543 re-gate after this merges.
**Status:** in progress (chore/eval-baseline-refresh)

## Approach
One pure function in `compare.ts`, `majorityCase(looks)`, decides a case
from several looks. Per dimension, the status with at least two votes wins.
An errored look casts no vote, and a case with fewer than two scored looks is
errored. A dimension with no majority is `fail`.

The rest builds on it:
- `majorityRun(runs)` checks that the runs are comparable, then applies
  `majorityCase` across them.
- `promoteBaseline` writes `majorityRun`'s result with a `majorityOf` record.
- `runGate` collects suspects and re-runs them once. It re-runs the undecided
  ones a second time, then replaces each suspect with `majorityCase` of its
  looks.
- `verifyAttestation` recomputes `majorityRun` from the baseline's sources.

The source runs live in `evals/results/`, so anyone can check the standard
from the tree.

Cost: a baseline takes three full runs, each about 13 minutes and 7M
subscription tokens. A gate run is one full run plus one or two targeted
re-runs.

## Milestones

### M1 — majority baseline and majority re-runs
Delivers: R1, R2, R3, R4, R5, R6
- [ ] `majorityCase` and `majorityRun`, with tests
- [ ] Promotion, the gate's re-runs and verify all use majorities, with tests
- [ ] Three runs of main promoted; `eval:gate` passes and attests
- [ ] `agent:check` green

## Decisions
- 2026-11-09 · Shane chose majority of three over promoting another single
  sample.
- 2026-11-09 · The third look runs only when the first two disagree. When they
  agree, a third look cannot change the majority.
- 2026-11-09 · A new case that did not pass becomes a suspect, like a
  regression. One bad sample of a new case is no more a finding than one bad
  sample of an old case.
- 2026-11-09 · No majority (a three-way split, or two scored looks that
  disagree) records `fail`. In a candidate run that fails closed. In a baseline
  it lowers the bar for that case, and the file's vote counts show it.
- 2026-11-09 · The three sources are the 2026-11-09 01:40 full run and the
  01:53 gate run's full pass (both on b57f35b3), plus one more run of the same
  coach.

## Session log
- 2026-11-09 · Spec written after a single-sample baseline failed unchanged
  `main` (`buried-contraindication` pass → fail, confirmed on re-run).

## Learned

## Next brief
