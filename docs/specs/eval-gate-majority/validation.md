# Eval gate on majorities — validation

## Gate
`npm run agent:check` on every commit, and `eval:verify` (the `coach-gate`
CI job) against the new attestation.

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `evals/__tests__/gate.test.ts` "promoteBaseline": three runs give majority statuses, vote counts and `majorityOf` sources; one or two runs are refused | unit | proven (PR #562) |
| R2 | `gate.test.ts` "promoteBaseline" refusals (backend, model, version, prompt hash, case set, errored case); `compare.test.ts` "majorityCase": a split with no majority gives `fail` | unit | proven (PR #562) |
| R3 | `gate.test.ts` "runGate: the majority re-run": agreeing first looks take no third; disagreeing looks take a third; the majority decides; two errored looks stay errored; a failing new case is re-run | unit | proven (PR #562) |
| R4 | `gate.test.ts`: `rerunFiles` lists every re-run, and the suspect's transcript hash comes from a majority look | unit | proven (PR #562) |
| R5 | `gate.test.ts` "verifyAttestation": a single-sample baseline, a missing source and an edited verdict each exit 1 | unit | proven (PR #562) |
| R6 | the committed baseline's `majorityOf`, the attested gate run, and `npm run eval:verify` exiting 0 on the branch | eval | proven (PR #562) |

## Beyond the gate
- This session runs the three source runs and the gate run on the
  subscription.

## Done means
Every box is checked, every proof is proven, and the PR is merged by Shane's
`shipit`. Then #552 is re-gated against the new baseline.
