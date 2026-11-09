# Eval gate on majorities — requirements

## Goal
The coach eval gate stops failing unchanged code. Today the baseline is one
sample, and a suspect case gets one more look. So a case that passes one sample
in four (`buried-contraindication`, measured 2026-11-08/09) turns the verdict
into a coin toss. `main` failed its own gate against a freshly promoted
baseline, and PR #552 failed on a planner case it does not touch.

After this change, the baseline is the per-case majority of three full runs,
and a suspect is judged by the majority of three looks. A verdict then reflects
the coach rather than the sample.

This is a gate repair (`ROADMAP.md` Rules: a broken gate goes first and takes
no slot). It serves Article VI: the gate keeps the coach's behavior honest, and
a gate people learn to re-run until green keeps nothing honest.

## Who and when
- A session with a coach change runs `npm run eval:gate` and gets a verdict
  that does not depend on which sample the baseline happened to catch.
- Shane promotes a new baseline after a deliberate behavior change.

## Requirements
- **R1** `npm run eval:baseline -- <a.json> <b.json> <c.json>` writes
  `evals/baseline/<model>.json`. Every case and dimension in it carries the
  majority status of the given runs and its vote counts. A `majorityOf` record
  names each source file. Promotion needs an odd number of runs, at least
  three.
- **R2** Promotion refuses runs that disagree on backend (it must be
  agent-sdk), model, `PROMPT_VERSION`, `promptFileHash` or case set. It also
  refuses runs with an errored case. A split with no majority records `fail`.
- **R3** The gate looks again at each suspect: a gated regression, an errored
  case, or a new case that did not pass. It takes a third look only when the
  first two disagree. The suspect's verdict is the per-dimension majority of
  its looks. A case that errored in two looks stays errored.
- **R4** The attestation records every re-run file. Each suspect's verdict and
  transcript hash come from a look that matches the majority.
- **R5** `eval:verify` fails three kinds of baseline: one with no `majorityOf`,
  one whose source files are missing from the tree, and one whose verdicts are
  not the majority of its sources.
- **R6** `evals/baseline/claude-sonnet-5.json` is replaced by the majority of
  three full runs of `main`'s coach. The gate passes against it with a fresh
  attestation.

## Out of scope
- Fixing the coach on `buried-contraindication`, which fails its constraint
  about three samples in four. That is a coach change with its own eval.
- The `planner-only-its-own-tool` refusal judge. It scored as a failure the
  behavior its own reasoning called correct. That is a separate case edit.
- Gating progression. It stays advisory.

## Open questions
- None.
