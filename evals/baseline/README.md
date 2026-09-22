# Baseline runs

One file per coach model: `<model>.json`, a full `--backend agent-sdk` result
file promoted with `npm run eval:baseline -- <result.json>`. It is what
`npm run eval:gate` compares a candidate run against, and what
`npm run eval:verify` re-hashes in CI.

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

Nothing lands here until PR #306 (`--backend agent-sdk`) merges and the first
full subscription run is promoted.
