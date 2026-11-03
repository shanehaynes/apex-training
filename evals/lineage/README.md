# Prompt-evolution lineage

Each file here is the full lineage of one `coach-prompt-evolution` workflow
run (`.claude/workflows/coach-prompt-evolution.js`): every variant proposed,
its per-dimension eval results, its diff, and whether it was kept — the
search's memory of what was tried. It keeps **aggregates only**: the per-case
verdicts and transcripts live in each run's result file, which is in a variant
worktree the run leaves behind. Commit those beside the lineage file when a
per-case claim must stay auditable; otherwise they are gone with the worktree.

Every lineage entry names its `backend`. The default, `agent-sdk` (a Claude
subscription), is a regression-detector measurement, not comparable
numerically to API-backend runs (evals/README.md, "Evolving the prompt
against the suite"); `api` entries are the production-shaped path.

Commit the lineage JSON, named `<date>__<model>.json`, in the PR of the run
that produced a winning variant, with the champion's diff and dimension table
in that PR's body. The diff itself lands in a second PR after `eval:gate` and
the `eval-analyst` agent, which references the lineage file. A run whose
champion is the unmodified prompt needs no file — a plateau is a result, not
an artifact; record it in the PR or report that ran it.
