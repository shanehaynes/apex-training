# Assurance: tiers, independent checks, and when to stop

Parallel lanes make work fast; independent checks make it right. Tokens buy
checks cheaply. What bounds quality is **independence** (a check written by
someone who could not coordinate with the author), and what bounds you is
**your judgment** (reviewers can do the reading; you do the deciding).

## Tiers decide the checks

Tier every lane when you plan it (`fleet.mjs lane … --tier T?`). Tier by
blast radius and by how much correctness depends on judgment rather than on a
test you already trust.

| Tier | Typical lane | Checks, cumulative |
|---|---|---|
| **T0** | docs, typos, config value, a mechanical rename the compiler checks | gate; gate-diff review |
| **T1** (default) | ordinary feature or fix with a strong existing suite | + a spot audit sample (≥1 lane per fleet reads the full diff) |
| **T2** | judgment-heavy logic, security-relevant, concurrency, anything that deletes or migrates data, the critical path | + spec lane when the request is ambiguous; + **verifier lane** (tests from spec only); + **adversarial reviewer** on the final SHA; + an audit lane reads the full diff (you read what it flags and the gate-path diff) |
| **T3** | irreversible or high-blast-radius: data loss possible, auth, money, production migrations, the automation itself | + **BEST-OF-N** (2–3 attempts, named design axes) with **two judges**; + verifier suite quality check (mutation); + a human signs off |

When in doubt, tier up. A lane that fails a check once moves up a tier for
its fix round.

## The flow for T2+ (what worked in practice)

1. **Spec, then contract.** For an ambiguous request, a spec lane reads the
   original request (not your plan) and lists every ambiguity. You resolve
   each into the written spec before implementation starts. Interfaces go in a
   contract lane.
2. **Implementation and verifier lanes launch together.** The verifier writes
   acceptance tests from the spec only, and proves each fails before the change
   exists — by assertion, not import error.
3. **Integrate and run the verifier's suite** against the fold
   (`combine-check.sh --check "<gate incl. acceptance>" <impl SHAs> <verify SHA>`).
4. **Adversarial review of the pinned result.** Reviewers get the spec and the
   diff, never the author's explanation, and must list what they attacked.
5. **Triage findings yourself.** Reproduce every critical one before acting —
   reviewer findings are claims too. Decide: fix now, fix later, or document as
   a limitation.
6. **Findings become spec amendments, not instructions to authors.** Write the
   required *behaviour* into the spec (numbered, e.g. A14), then:
   - the verifier (or you — never the author) writes a failing acceptance test
     per amendment, pinned at a SHA;
   - the author implements from the amendment, may add its own new tests in
     files it owns (each must fail on the old code), and reports under
     MUTATION how it checked that;
   - the author merges the pinned acceptance SHA and changes code only until
     it passes;
   - you confirm `git diff <pin> <author SHA> -- <acceptance path>` is empty.
7. **Repeat review on the fixed code** — fixes are where new bugs hide.

### When to stop reviewing

Stop when a review round of the final code finds no critical and no major
issue, or when what it finds is outside what any check here can reach (say
so under NOT VERIFIED). In the build that produced this file, round one found
data-loss bugs in every script; round two found fewer, less likely ones;
round three's findings were edge cases. Converging severity is the signal.

## Verifier lane rules

- Spec only; never an implementation branch.
- Every test for new behaviour fails before the change, and the report says
  why each one fails. A test that passes before the change is dropped or
  justified as a regression guard.
- Ambiguous clauses are marked and listed under SPEC GAPS; you rule on each
  (amend the spec) before those tests count.
- **Probabilistic tests** (races, concurrency) are labelled as such with their
  observed failure rate on the old code. A pass proves little; a fail is real.
- **Weak spot to watch**: the verifier can encode an ordering or behaviour
  stricter than the spec. When an author reports "this test demands more than
  the contract", rule on it yourself if the spec text settles it (accept the
  stricter behaviour into the spec if it is better, otherwise have the verifier
  fix its own test); if reasonable readings of the spec disagree, send it to
  an adjudicator (below).
- **T3: check the suite itself.** Mutate the implementation (flip a
  condition, drop a guard, remove a lock) and confirm the suite fails.
  Undetected mutants are NOT VERIFIED.

## Adversarial reviewer rules

- A detached worktree at the pinned SHA (`lane.sh new --detach`), never the
  author's worktree.
- An explicit attack-surface list; the report marks each item attacked or not.
- Severity and confidence per finding; evidence (a reproduction) or it didn't
  happen.
- A second review round gets the list of previously found issues and must
  report each as holds/broken — then attack the fixes.
- Equal coverage across BEST-OF-N attempts, or the judge's "confirmed
  findings" column penalizes whichever attempt was reviewed harder.

## BEST-OF-N and judging

- **Diversity must be real.** Same model, same brief, same spec means
  correlated failures: independently written versions tend to fail on the
  same hard inputs, most often where the spec is hard (N-version programming,
  Knight & Leveson, 1986). Give each attempt a named design axis.
- **Use the attempts as each other's oracle.** Run them side by side on
  generated inputs; every disagreement is a bug in one of them or a gap in the
  spec. This is where multiple versions pay for themselves.
- **Choose on evidence, in order:** gate → verifier suite → reviewer findings
  → judges. Never by comparing the attempts' own reports.
- **Two judges, opposite orders**, scores per criterion before a ranking;
  disagreement is a tie you break on correctness. Record the ruling:
  `fleet.mjs decide "<why>" --kind judge --lane <winner>`. The latest ruling
  stands; `fleet.mjs check` errors if a non-winner merges.
- Losers are retired (`lane.sh retire`), never merged in part. A good idea from
  a loser is a follow-up for the winner, re-implemented, not copied.

## Disputes, fix loops and escalation

- An author who believes a test is wrong reports it (STATUS: blocked, the
  assertion and why) and never edits it.
- **Adjudication**: an adjudicator lane gets the spec, the test and its
  failure output — neither side's reasoning — and rules test-correct,
  test-wrong or spec-ambiguous. The ruling amends the spec; a fresh verifier
  brief rewrites the test.
- **Fix-loop cap**: `fleet.mjs set <lane> round=N` on each fix round;
  `fleet.mjs check` warns at `FLEET_FIX_ROUNDS` (default 3). At the cap, stop
  and escalate to a human with the history.
- A race where every lane ends ruled-out or stopped has no win:
  `fleet.mjs check` warns; replan or escalate.

## Measure whether the checks pay

`fleet.mjs metrics` reports lanes per tier and role, BEST-OF-N groups where
the winner was not the first attempt, reviewer findings vs confirmed,
disputed verifier tests, fix rounds, and post-merge defects per tier (record
them with `fleet.mjs defect <lane> "<what>"`). Read it after each fleet:

- Winners that are never the first attempt at T3 → BEST-OF-N earns its cost.
- Reviewers whose findings are rarely confirmed → sharpen their briefs.
- Defects escaping at T1 that T2 would have caught → tier those lanes up.
- Many disputed verifier tests → the spec is the problem; add a spec lane.
