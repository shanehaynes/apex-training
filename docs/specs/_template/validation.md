# <Feature> — validation

How each requirement is proven. Written before the code, with the
requirements, so the proof is decided before anyone is tempted to fit it to
the result.

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it).

## Requirement proofs
One row per requirement in `requirements.md`; none may be blank when the
feature ships.

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | <test file and case name, or the exact check> | unit · integration · e2e · eval · device run · screenshot | not proven · proven (PR #) |
| R2 | <…> | | |

## Beyond the gate
<Anything `agent:check` cannot prove: a live-stack e2e, a TestFlight device
run, a coach eval, a production check. Name who proves it: a session, the
`app-verifier` agent, the `eval-analyst` agent, or Shane.>

## Done means
Every milestone box in `plan.md` checked, every proof above proven, every PR
merged, `scripts/git-tidy.sh --yes` run, the Next brief filled in, and the
replan opened (`docs/workflow-essentials.md`, "Replanning").
