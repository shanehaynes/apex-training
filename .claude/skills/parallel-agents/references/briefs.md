# Briefs, messages and reports

A worker starts with nothing but its brief. Write it for a capable engineer
who has never seen the repository or your conversation, cannot ask a
question, and will be judged on what they report. Vague delegation ("look
into the auth bug") produces workers that duplicate each other, drift out of
scope, or stop early.

**How to use this file**

- Copy the template and replace every `{{SLOT}}` (a slot is `{{NAME}}` or
  `{{NAME: what goes here}}`, always on one line). Optional blocks are slots
  too (named `OPTIONAL_…`): replace them with the text they describe, or delete
  the line. The guard hook denies an Agent/Task launch whose prompt still
  contains a slot; to quote the syntax literally in a brief, write
  `{{ NAME }}` with spaces. **In a Workflow the hook cannot see `agent()`
  prompts** — check them yourself before running (see §W).
- **Paste the report schema (§F) into the brief.** Workers cannot see this
  file; a worker told to "use the report format" invents one and drops the
  fields you need (GATE TOUCHED, EXTERNAL ACTIONS).
- Bookkeeping — shape, group, tier, dependencies — goes in the fleet ledger,
  not in worker briefs. A worker needs to know what to do, not how you are
  scheduling it; a BEST-OF-N attempt must not learn it has rivals.
- Diffs you hand out are `<BASE>..<SHA>` with `<BASE>` =
  `git merge-base origin/main <SHA>`, computed by you — never a live branch
  name, which can move after you checked it.

**What each lane type is given** — independence is decided by what goes in:

| Lane | Gets | Never gets |
|---|---|---|
| Writing | goal, context, contract, ownership, gate | other lanes' branches or reports |
| Race | one hypothesis, the win condition | sibling hypotheses or progress, that it is racing |
| BEST-OF-N attempt | the same spec and gate as its siblings, a design-axis hint | that siblings exist, their hints or work |
| Verifier | spec, interfaces/contract, expected behaviour | any implementation branch or report |
| Reviewer | spec, the diff at a pinned SHA | the author's report, reasoning or transcript |
| Judge | spec, attempts' diffs by SHA under shuffled neutral labels, checked results | attempts' reports, branch names, your preference |
| Spec | the original request, the codebase | your spec or plan |
| Adjudicator | spec, the disputed test, its failure output | either side's reasoning |

---

## A. Writing lane (also: BEST-OF-N attempt, contract lane)

```markdown
Lane: {{WORKTREE_ABS_PATH}}

## Goal
{{GOAL: one or two sentences, stated as something checkable}}
Why: {{WHY: the reason, so you can make calls I did not anticipate}}

## Context you need
{{CONTEXT: relevant files and functions, decisions made, approaches rejected and why, the issue or spec — facts pasted, not "see above"}}
{{OPTIONAL_CONTRACT: "Build against the contract at <path> (merged at <sha>). Do not change it; if it is wrong, stop and report." — or delete this line}}
{{OPTIONAL_DESIGN_AXIS: BEST-OF-N attempts only: "Approach: <the named design axis for this attempt>" — or delete this line}}

## Your environment
- This worktree is yours. Run every command there: `cd {{WORKTREE_ABS_PATH}} && …`
  or `git -C {{WORKTREE_ABS_PATH}} …`. Your shell may start elsewhere
  (often the primary checkout, which must stay clean).
- Branch {{BRANCH}} is checked out; dependencies are installed.
- Port if you start a server: {{PORT}}. Kill only the PID on that port.

## Ownership
- You own: {{OWNED_PATHS}}
- Do not change: {{FORBIDDEN_PATHS: other lanes' files, shared/generated files, lockfiles, migrations and counters, CI and automation config}}
- Gate-protected — do not change: {{GATE_PROTECTED_PATHS: existing tests, fixtures, snapshots, thresholds, runner/CI config, skip lists, verification paths}}.
  If you believe a test is wrong, report which, why, and the change you
  propose. Do not edit it. New tests in files you own are welcome; each must
  fail on the code before your change (say how you checked, under MUTATION).
- A change you need outside what you own: describe it precisely in your report.

## Shared state and side channels
- {{SERIALIZED_RESOURCES: e.g. the local DB only via `<skill>/scripts/with-lock.sh db <cmd>` — or "none"}}
- Never: reset/seed shared databases, touch the primary checkout, open PRs,
  merge (except a merge a message from me tells you to make), force-push,
  kill processes by name, stash without a unique message.
- Do not read other lanes' branches, worktrees or reports. What you need from
  them comes from me.
- Irreversible external actions: describe the exact action; do not perform it.

## Gate
Before you report done, run and pass:
{{GATE_COMMANDS: one per line; all safe in parallel}}
You run the gate; you cannot change it. {{NOT_HERE: checks you must not run here and why, or "none"}}
An honest `STATUS: partial` with the failing output is a good result. Never
make a check pass by special-casing test inputs, broadening catches, mocking
the unit under test, loosening assertions, or skipping tests — I diff for
exactly these.

## Done means
1. Changes committed on {{BRANCH}} with a message that says what and why.
2. Pushed: `git -C {{WORKTREE_ABS_PATH}} push -u origin {{BRANCH}}`.
3. `git status` clean. Git-ignored outputs that matter go under ARTIFACTS.
4. Your final message is the lane report below, and nothing else.

## After you report
I may continue you with a question, a fix request, a relayed fact or a stop.
Leave the worktree as it is, do only what the message asks, and end with the
follow-up report below.

## If you are blocked
Stop and report. A refused permission, a hook block, a held lock, a failing
check you cannot fix within your ownership, or an ambiguity that changes the
design is information for me. Do not route around it or widen your scope to
get green.

## Lane report
{{PASTE: §F lane report}}

## Follow-up report
{{PASTE: §F follow-up report}}
```

**BEST-OF-N attempts** get identical briefs except the lane, branch and the
design-axis hint (each attempt differs on a *named* axis — algorithm, data
structure, where the logic lives — so their failures are less likely to
coincide). Nothing mentions rivals, ranking or winning: competitive framing
is pressure to weaken checks.

**Contract lane** (`contract/<slug>`, usually yours): the goal is the
interface — types or schema, stubs that throw "not implemented", and one test
that pins the shape. That test is gate-protected once merged.

## B. Race lane (FIRST-SUFFICIENT)

Template A with its Goal and Gate sections replaced by the block below
(insert it right after the `Lane:` line) and its "Done means" item 4 kept:

```markdown
## Your hypothesis
{{HYPOTHESIS: the one line of attack this lane owns}}

## Win
{{WIN_CONDITION: a command that fails on unmodified origin/main with this exact output: …}}.
Show the command and its output from your worktree; I will re-run
it myself. It must fail for the reason your hypothesis names — explain that
link in the report.

## Where the repro lives
Only under {{REPRO_DIR: a path outside the test suite, not gate-protected}}.
Do not add it to the test suite and do not fix the bug.

## Gate
{{BUILD_AND_LINT_COMMANDS}} must pass. The repro is expected to fail; that
failure is the result.

## Checkpoints, stopping, done
- Commit and push at every checkpoint — each time you rule something in or out.
- If told to stop: commit, push, release any lock, kill the PID on your port,
  and reply exactly `STOPPED <sha>`.
- "Ruled out" means evidence the hypothesis cannot produce the symptom (a
  command and its output), not failing to find a repro. A clean negative with
  that evidence is a result; so is "inconclusive" with what you tried.
- Done: pushed, clean, lane report with RESULT and its evidence filled.
```

## C. Verifier lane

Template A, on branch `verify/<slug>`, with Goal, Context, Ownership and Gate
replaced by:

```markdown
## Goal
Write acceptance tests for {{FEATURE}} from the spec below. They will run
against an implementation written by someone else, whom you will never see.
Their value is exactly the bugs a careless implementation has that its own
author's tests miss.

## Spec
{{SPEC: goal, interfaces or contract, expected behaviour, edge cases}}

## Ownership
You own only {{VERIFICATION_PATH: e.g. tests/acceptance/<slug>/}}.

## Requirements
- Test behaviour through public interfaces, not internals.
- Every test for new behaviour must fail before the change exists — by an
  assertion, or the contract stub's "not implemented" error; never by an
  import, collection or harness error. Run the suite here (origin/main plus the
  contract plus your tests) and report each test's failure reason.
- Cover the edge cases the spec names and the ones a careless implementation
  gets wrong. Where the spec is silent and you had to assume, mark the case
  `AMBIGUOUS:` and list it under SPEC GAPS — I will rule before it counts.
- Every case runs under a timeout; the harness never crashes on a missing or
  hanging implementation — it reports FAIL.
- Do not look at any other branch or worktree.

## Gate
{{LINT_COMMAND}} passes on your tests, and the suite runs to completion.
```

Its report is the §F lane report plus the two verifier lines shown there
(FAILS BEFORE CHANGE, SPEC GAPS) — paste both.

## D. Adversarial reviewer lane

You cut a detached worktree at the pinned SHA: `<skill>/scripts/lane.sh new
--detach <slug> --base <SHA> "review"`.

```markdown
Lane: {{REVIEW_WORKTREE_ABS_PATH}}
Reviewing: detached at {{SHA}}

## Goal
Break this change. {{STAKES: what goes wrong for users if it is broken}}.
Find inputs it mishandles, paths it misses, races, and places where its tests
are weaker than they look. A review that finds nothing is only credible if it
says what it tried.

## What you review
Spec: {{SPEC}}
Change: `git -C {{REVIEW_WORKTREE_ABS_PATH}} diff {{BASE}}..{{SHA}}`. That is
what is under review; read any code in the worktree you need to judge it. You
do not get the author's explanation, on purpose.
{{OPTIONAL_PRIOR_FINDINGS: second round only: "Previously found and reportedly fixed — verify each holds and attack its edges: <list>" — or delete this line}}

## Attack surface — list each as attacked (how) or not attacked
{{ATTACK_SURFACE: every changed function and every spec clause, plus the platform and concurrency concerns that apply}}

## Environment and shared state
- Run everything in fixtures you create under `mktemp -d` (delete them after).
  Port {{PORT}}; kill only its PID.
- Never: touch the primary checkout or other worktrees, reset shared state,
  call external services, commit, push, stash.
- Evidence or it didn't happen: every finding carries a reproduction and its
  output, or file:line with exact reasoning.

## Report (final message, nothing else)
{{PASTE: §F reviewer report}}
```

## E. Judge lane (BEST-OF-N)

Run **two judges** with the attempts in opposite orders. Present attempts
under neutral labels (A, B, C) by SHA in shuffled order — branch suffixes
give the order away. If the judges disagree, treat it as a tie and decide
yourself on criterion 1.

```markdown
Lane: read-only

## Goal
Rank {{N}} independent implementations of the same spec. One will merge.

## Spec
{{SPEC}}

## Attempts
Read each with `git -C {{PRIMARY_ABS_PATH}} diff <BASE>..<SHA>` (reading
there is fine; do not build, check out or write there):
{{ATTEMPTS: "- A: <BASE>..<SHA>" one per line, shuffled}}
Checked results — I ran these; treat them as facts:
{{RESULTS_TABLE: attempt | gate | verifier suite | confirmed reviewer findings}}
Every attempt had the same reviewer coverage. Tests an attempt wrote itself
are not evidence of its correctness.

## Criteria, in order
1. Correctness against the spec, including edge cases.
2. Risk: what could break that no check covers.
3. Simplicity and fit with the surrounding code.
4. Maintainability.
Scores: 1 = wrong or unsafe, 3 = correct with a real weakness you can point
to, 5 = correct and you could find nothing to fix. Length, comments and
tests an attempt wrote for itself earn nothing. If attempts tie on 1 and 2,
prefer the smaller diff.

## Report (final message, nothing else)
{{PASTE: §F judge report}}
```

## Spec lane and adjudicator lane

```markdown
Lane: read-only
## Goal
{{SPEC_GOAL: "Find every ambiguity in this request that two competent engineers would resolve differently" | "Rule on a disputed test"}}
## Material
{{MATERIAL: spec lane — the original request and the codebase, not my plan; adjudicator — the spec, the disputed test and its failure output, neither side's reasoning}}
## Report (final message, nothing else)
FINDINGS: <spec lane: each ambiguity, the two readings, and what depends on
it> | <adjudicator: RULING test-correct | test-wrong | spec-ambiguous, with
the spec clause and the reasoning>
NOT CHECKED: <…>
```

A ruling of test-wrong or spec-ambiguous amends the spec; a fresh verifier
rewrites the test from the amended spec. The author never edits it.

---

## F. Report schemas

**Lane report** — final message of every writing, race and verifier lane:

```
STATUS: done | partial | blocked
BRANCH: <branch>   SHA: <full sha of pushed head, or none>   PUSHED: yes | no
CHANGED: <files, one line each with the why if not obvious>
GATE:
- <command> → pass | fail (<one-line reason>)
RESULT: <race lanes: win | ruled-out | inconclusive — with the command and its output; others: n/a>
MUTATION: <new tests you wrote: how you checked each fails on the old code; or none>
GATE TOUCHED: none | <each gate-protected path changed, and why>
EXTERNAL ACTIONS: none | <what, where, reversible y/n; irreversible ones
  as the exact proposed action, not performed>
ARTIFACTS: none | <git-ignored outputs that matter, with paths>
NOT VERIFIED: <what the gate does not cover that this could break — specific>
OUTSIDE MY OWNERSHIP: none | <precise change needed elsewhere>
DECISIONS: <judgment calls where the brief left room; alternatives rejected>
FOLLOW-UPS: <problems noticed and deliberately not fixed>
BLOCKER: <only if blocked: exact command, exact error, what I need>
```

Verifier lanes add two lines to the lane report:

```
FAILS BEFORE CHANGE: <per case: fails now yes/no, and the failure reason (assertion / not-implemented)>
SPEC GAPS: <clauses you had to interpret, how, and which cases are marked AMBIGUOUS>
```

**Follow-up report** — ends every continuation:

```
RE: <the message this answers>
STATUS: done | blocked
ANSWER | FIX: <the answer, or what changed and why>
SHA: <new pushed head | unchanged>   PUSHED: yes | no | n/a
GATE: <command → pass|fail, if code changed>
GATE TOUCHED: none | <path, why>
EXTERNAL ACTIONS: none | <what, where, reversible y/n>
BLOCKER: <only if blocked: the assertion or step, and why>
```

**Reviewer report:**

```
COVERAGE: <each attack-surface item: attacked (how) | not attacked>
FINDINGS:
- [critical|major|minor] confidence=high|med|low  <file:line> — <what is wrong>
  EVIDENCE: <command → output, or reasoning>
  EXPECTED vs ACTUAL: <…>
  PROPOSED TEST: <the test that would catch it, as text; you do not write it>
FIXES VERIFIED: <each previously found issue: holds | broken (how)> (second round)
TRIED, NOTHING FOUND: <attacks that failed>
EXTERNAL ACTIONS: none | <what, where>
NOT CHECKED: <what you did not get to>
```
Severities: critical = data loss or corruption, a security exposure, or a
failure presented as success; major = a wrong result a user will hit;
minor = a rough edge.

**Judge report** — evidence before the verdict:

```
SCORES: <per attempt, per criterion 1–4: score 1–5, with file:line evidence>
DECISIVE DIFFERENCE: <the one thing that separates first from second>
RANKING: <A > C > B>
WORTH SALVAGING: <ideas in lower-ranked attempts the winner should adopt>
CONFIDENCE: high | medium | low — <why>
```

**JSON Schemas for Workflow `agent()` calls.** Each top-level key names one
report; pass *the value under that key* as the call's `schema`. Fields that
may legitimately be unknown (a blocked lane's SHA) allow `null` — never
invent a value.

```json
{
  "lane_report": {
    "type": "object",
    "required": ["status", "branch", "sha", "pushed", "changed", "gate", "gate_touched", "external_actions", "not_verified"],
    "properties": {
      "status": {"enum": ["done", "partial", "blocked"]},
      "branch": {"type": "string"},
      "sha": {"type": ["string", "null"]},
      "pushed": {"type": ["boolean", "null"]},
      "changed": {"type": "array", "items": {"type": "string"}},
      "gate": {"type": "array", "items": {"type": "object", "required": ["command", "result"],
        "properties": {"command": {"type": "string"}, "result": {"enum": ["pass", "fail"]}, "reason": {"type": "string"}}}},
      "result": {"enum": ["win", "ruled-out", "inconclusive", null]},
      "result_evidence": {"type": ["string", "null"]},
      "mutation": {"type": "array", "items": {"type": "string"}},
      "gate_touched": {"type": "array", "items": {"type": "string"}},
      "external_actions": {"type": "array", "items": {"type": "object", "required": ["what", "where", "reversible", "performed"],
        "properties": {"what": {"type": "string"}, "where": {"type": "string"}, "reversible": {"type": "boolean"}, "performed": {"type": "boolean"}}}},
      "artifacts": {"type": "array", "items": {"type": "string"}},
      "not_verified": {"type": "array", "items": {"type": "string"}},
      "outside_my_ownership": {"type": "array", "items": {"type": "string"}},
      "decisions": {"type": "array", "items": {"type": "string"}},
      "follow_ups": {"type": "array", "items": {"type": "string"}},
      "fails_before_change": {"type": "array", "items": {"type": "object", "required": ["case", "fails_now"],
        "properties": {"case": {"type": "string"}, "fails_now": {"type": "boolean"}, "reason": {"type": "string"}}}},
      "spec_gaps": {"type": "array", "items": {"type": "string"}},
      "blocker": {"type": ["string", "null"]}
    }
  },
  "follow_up_report": {
    "type": "object",
    "required": ["re", "status", "answer_or_fix", "sha", "pushed", "gate_touched", "external_actions"],
    "properties": {
      "re": {"type": "string"},
      "status": {"enum": ["done", "blocked"]},
      "answer_or_fix": {"type": "string"},
      "sha": {"type": ["string", "null"]},
      "pushed": {"enum": ["yes", "no", "n/a"]},
      "gate": {"type": "array", "items": {"type": "object", "required": ["command", "result"],
        "properties": {"command": {"type": "string"}, "result": {"enum": ["pass", "fail"]}}}},
      "gate_touched": {"type": "array", "items": {"type": "string"}},
      "external_actions": {"type": "array", "items": {"type": "string"}},
      "blocker": {"type": ["string", "null"]}
    }
  },
  "reviewer_report": {
    "type": "object",
    "required": ["coverage", "findings", "tried_nothing_found", "external_actions", "not_checked"],
    "properties": {
      "coverage": {"type": "array", "items": {"type": "object", "required": ["item", "attacked"],
        "properties": {"item": {"type": "string"}, "attacked": {"type": "boolean"}, "how": {"type": "string"}}}},
      "findings": {"type": "array", "items": {"type": "object", "required": ["severity", "confidence", "where", "what", "evidence"],
        "properties": {"severity": {"enum": ["critical", "major", "minor"]}, "confidence": {"enum": ["high", "med", "low"]},
          "where": {"type": "string"}, "what": {"type": "string"}, "evidence": {"type": "string"},
          "expected_vs_actual": {"type": "string"}, "proposed_test": {"type": "string"}}}},
      "fixes_verified": {"type": "array", "items": {"type": "object", "required": ["issue", "holds"],
        "properties": {"issue": {"type": "string"}, "holds": {"type": "boolean"}, "how": {"type": "string"}}}},
      "tried_nothing_found": {"type": "array", "items": {"type": "string"}},
      "external_actions": {"type": "array", "items": {"type": "string"}},
      "not_checked": {"type": "array", "items": {"type": "string"}}
    }
  },
  "judge_report": {
    "type": "object",
    "required": ["scores", "decisive_difference", "ranking", "confidence"],
    "properties": {
      "scores": {"type": "array", "items": {"type": "object", "required": ["attempt", "criterion", "score", "evidence"],
        "properties": {"attempt": {"type": "string"}, "criterion": {"type": "integer", "minimum": 1, "maximum": 4},
          "score": {"type": "integer", "minimum": 1, "maximum": 5}, "evidence": {"type": "string"}}}},
      "decisive_difference": {"type": "string"},
      "ranking": {"type": "array", "items": {"type": "string"}},
      "worth_salvaging": {"type": "array", "items": {"type": "string"}},
      "confidence": {"enum": ["high", "medium", "low"]}
    }
  },
  "research_report": {
    "type": "object",
    "required": ["conclusions", "not_checked"],
    "properties": {
      "conclusions": {"type": "array", "items": {"type": "object", "required": ["claim", "evidence", "verified"],
        "properties": {"claim": {"type": "string"}, "evidence": {"type": "string"}, "verified": {"type": "boolean"}}}},
      "not_checked": {"type": "array", "items": {"type": "string"}}
    }
  },
  "ruling_report": {
    "type": "object",
    "required": ["findings", "not_checked"],
    "properties": {
      "findings": {"type": "array", "items": {"type": "string"}},
      "ruling": {"enum": ["test-correct", "test-wrong", "spec-ambiguous", null]},
      "not_checked": {"type": "array", "items": {"type": "string"}}
    }
  }
}
```

## W. Fleets run as a Workflow

Load the workflow-authoring skill before writing the script. Three things the
guard hook cannot do for you there, because it never sees `agent()` prompts:

- **Check slots yourself**: before running, make sure no prompt the script
  builds contains `{{` followed by an upper-case letter, and every writing
  agent's prompt carries its `Lane:` line and report schema.
- **Keep the channel rule in the script**: never feed one agent's output into
  another agent's prompt without a checking step between them (a command you
  run, a verifier, or your own review). A pipeline that passes a report
  straight into the next prompt is peer-to-peer messaging with extra steps.
- **Express edges, not phases**: start each dependent `agent()` from its own
  dependencies' results (or use `pipeline`), not after a barrier across all
  lanes; record lanes in the ledger from the script or before running it.

## G. Messages to live lanes

Each names the lane's branch, so a message that reaches the wrong worker is
obvious. Writing and race lanes receive all of these. Independent lanes
receive only FOLLOW-UP about their own output; a BEST-OF-N attempt receives
FIX only after it has been judged the winner.

```markdown
FOLLOW-UP ({{BRANCH}}): {{ONE_PRECISE_QUESTION}}. Answer only this; end with
your follow-up report.

FIX ({{BRANCH}}): {{FINDING}} — evidence: {{EVIDENCE}}.
Run `git -C {{WORKTREE_ABS_PATH}} merge --no-edit {{VERIFY_SHA}}` (the
verification branch, pinned). It is the only other commit you may merge;
report it under GATE TOUCHED. Then make {{TEST_SELECTOR}} pass by changing
code only. Do not edit any test. If it cannot pass without contradicting the
spec, stop: follow-up report with STATUS: blocked and the assertion under
BLOCKER. Run the gate, push, end with your follow-up report.

RELAY ({{BRANCH}}): {{CHECKED_FACT}} — source: {{SOURCE: sha | run | log}}.
What it changes for you: {{IMPACT}}. {{ACTION: e.g. merge origin/main before your next gate run}}

STOP ({{BRANCH}}): commit, push, release locks, kill the PID on your port,
reply `STOPPED <sha>`.
```

## H. Continuation brief (respawn)

Only after the previous worker has finished and its head is pushed; two
writers never share a worktree.

```markdown
{{ORIGINAL_BRIEF: verbatim, including its pasted report schemas}}

## Where this lane stands
You are continuing a lane another worker started. The worktree and branch are
authoritative: first run `git -C {{WORKTREE_ABS_PATH}} log --oneline
origin/main..HEAD` and `git -C {{WORKTREE_ABS_PATH}} status`, and stop and
report if either disagrees with this summary.
Last report: {{LAST_REPORT}}
Since then: {{CHECKED_FACTS: merges, relays, confirmed findings}}
Now: {{TASK}}
```

## Brief review — before launching

- Could a stranger do this without asking anything? What would they ask?
- Is the report schema pasted in, and is every `{{SLOT}}` filled?
- Does any file appear in two lanes' "you own" (other than BEST-OF-N siblings)?
- Is every gate command safe in parallel (no shared DB, fixed port, device)?
- Is "done" — or the win — checkable from outside: a SHA, a command you can re-run?
- Independence: does any verifier, reviewer, judge, spec or attempt brief
  contain an author's reasoning, a sibling's work, a branch name that reveals
  order, or a hint of the answer you expect? Take it out.
- Did you say what *not* to do, including not fixing the adjacent bug?
- Is the lane recorded in the ledger (`fleet.mjs lane …`) with its brief path?
