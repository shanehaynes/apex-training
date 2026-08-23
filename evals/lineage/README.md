# Prompt-evolution lineage

Each file here is the full lineage of one `coach-prompt-evolution` workflow
run (`.claude/workflows/coach-prompt-evolution.js`): every variant proposed,
its per-dimension eval results, and whether it was kept — the search's
persistent memory, the same way `results/` is the suite's.

Commit the lineage JSON in the same PR that applies a run's winning diff, named
`<date>__<model>.json`. A run whose champion is the unmodified prompt needs no
PR and no file — a plateau is a result, not an artifact.
