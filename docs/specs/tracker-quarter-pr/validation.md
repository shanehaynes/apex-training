# Tracker quarterly PR — validation

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it).

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `api/__tests__/tracker-quarter-best.test.ts` (values through buildBootstrap); `src/lib/tracking/__tests__/quarterBest.test.ts` "calendar quarters", "reads only this quarter…", "attachQuarterBests…"; `api/__tests__/ios-fixture-shape.test.ts` (field names); CI's full job checks the fixture values | unit · integration | proven (this branch) |
| R2 | `quarterBest.test.ts` "takes the heaviest estimated 1RM…", "skips warm-ups, autofills and climbing pitches", "ranks a weighted set over an unweighted one…", "ranks a weighted hold or carry…", "keeps the first of two equal sets…", "ignores a row with nothing it can rank" | unit | proven (this branch) |
| R3 | `src/components/tracker/__tests__/QuarterPr.test.tsx` "heads the column with the quarter…", "puts the best on the first working set…"; `e2e/mock/quarter-pr.spec.ts` first test | unit · e2e | proven (this branch; e2e in CI) |
| R4 | `QuarterPr.test.tsx` "opens on the first field…", "holds a field fully shown for four seconds…"; `quarterBest.test.ts` "how the tracker reads a quarterly best"; `e2e/mock/quarter-pr.spec.ts` (cycle and reduced motion) | unit · e2e | proven (this branch; e2e in CI) |
| R5 | `QuarterPr.test.tsx` "keeps the plan targets…", "leaves a non-strength exercise…"; `e2e/mock/quarter-pr.spec.ts` (mobility keeps its target) | unit · e2e | proven (this branch) |

## Beyond the gate
- CI's `full` job: `ios-read.integration.test.ts` checks the hand-written
  fixture values against the live stack.
- Shane: a look at the fade on his phone.

## Done means
Every milestone box in `plan.md` checked, every proof above proven, every PR
merged, `scripts/git-tidy.sh --yes` run, the Next brief filled in, and the
replan opened (`docs/workflow-essentials.md`, "Replanning").
