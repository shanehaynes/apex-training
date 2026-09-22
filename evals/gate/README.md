# Gate attestation

`attestation.json` lands here: the record of a `npm run eval:gate` run that
passed, written locally against a Claude subscription and committed in the PR
it attests to.

It carries the two hashes that make it mean something — `promptFileHash` (what
the coach is) and `evalSurfaceHash` (what the question was) — plus
`PROMPT_VERSION`, the backend and model, the baseline file and its sha256, the
result file, every case's per-dimension verdict, and the transcript hashes.

CI's `coach-gate` job runs `npm run eval:verify`, which re-derives both hashes
from the tree and checks them against this file. It calls no model and needs no
secret: a gate that had to spend tokens in GitHub Actions would have to spend
API credit, and the entitlement that pays for this one cannot run there.

This directory is deliberately **not** a held path. The attestation is evidence,
not a standard: it is only worth anything while its hashes match the tree, so
forging it is the same amount of work as running the gate, and a stale one
fails CI on its own.

Nothing lands here until PR #306 merges and the first gate run is made.
