# Baseline runs

One file per coach model: `<model>.json`. It holds the per-case majority of
three full `--backend agent-sdk` runs, promoted with
`npm run eval:baseline -- <a.json> <b.json> <c.json>`. Its `majorityOf`
record names the three source runs, which live under `evals/results/`. It is
what `npm run eval:gate` compares a candidate run against. In CI,
`npm run eval:verify` re-hashes it and re-derives it from its sources. A single
promoted sample is refused; see "A baseline is the majority of three runs" in
[../README.md](../README.md).

**This directory is a held path** (`scripts/merge-policy.mjs`). It is the
definition of correct coach behavior, so changing it is not a code change —
it is a change to the standard the code is judged by, and no agent may merge
that alone. A PR that does not change behavior needs no baseline edit and
auto-merges as usual; a PR that deliberately changes behavior has to refresh
the baseline, which routes it to Shane. That is the intended cost.

Only an `agent-sdk` result may be promoted. An API-backend run measures a
different runtime — different tool loop, no `max_tokens` control, different
token accounting (see **Backends** in [../README.md](../README.md)) — and
comparing across the two would produce noise that reads like regression.

History: the first baseline (2026-10-06) was one promoted run. It was replaced
on 2026-11-09 by a majority of three runs, after a single sample failed
unchanged `main` (docs/specs/eval-gate-majority).
