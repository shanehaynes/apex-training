# Lane brief and report

A worker starts with nothing but this brief. Write it as if handing the task
to a capable engineer who has never seen the repository or this conversation,
will not be able to ask a question, and will be judged on what they report.

Research on orchestrator–worker systems found the same failure repeatedly:
short, vague delegation ("look into the auth bug") produces workers that
duplicate each other, drift out of scope, or stop early. Every section below
exists to close one of those gaps.

## Template — writing lane

```markdown
## Goal
<One or two sentences: the outcome, stated as something checkable.>
Why: <the reason this matters, so you can make calls I did not anticipate>.

## Context you need
<What you already know that the worker would otherwise rediscover: the
relevant files and functions, the decision already made, the approach
already rejected and why, links to the issue/spec. Paste facts, not a
pointer to "the conversation above" — it cannot see it.>

## Your environment
Lane: <ABSOLUTE PATH>
- That worktree is yours. Run every shell command there:
  `cd <ABSOLUTE PATH> && …` or `git -C <ABSOLUTE PATH> …`. Your shell may
  start somewhere else (often the primary checkout, which must stay clean).
- Branch: <branch>, already created and checked out. Dependencies installed.
- Port (if you start a server): <port>. Kill only the PID on that port.

## Ownership
- You own: <files/dirs this lane may change>.
- Do not change: <files other lanes own, shared/generated files, lockfiles,
  migrations/global counters, CI and automation config>. If you need a change
  there, stop and say what and why in your report.

## Shared state
- <Serialized resource>: only through `<lock wrapper> <cmd>`. <Or: not at all.>
- Never: reset/seed shared databases, touch the primary checkout, open PRs,
  merge, force-push, kill processes by name, stash without a unique message.

## Gate
Before you report done, run and pass:
- `<build>`
- `<unit tests>`
- `<lint/typecheck>`
All are safe in parallel with other lanes. <Name any check you must NOT run
here and why — e.g. live e2e needs the shared DB; the orchestrator runs it.>

## Done means
1. Changes committed on <branch> with a message that says what and why.
2. Pushed: `git -C <worktree> push -u origin <branch>`.
3. Worktree clean (`git status` empty). Anything git-ignored you produced and
   that matters (screenshots, reports) is listed in your report with its path.
4. Final message is the report below, and nothing else.

## If you are blocked
Stop and report. A permission refusal, a hook block, a held lock, a failing
check you cannot fix within your ownership, or an ambiguity that changes the
design — each is information for the orchestrator. Do not route around it.
Do not widen your scope to get green.
```

## Template — read-only lane (light path)

```markdown
Lane: read-only

## Question
<The specific thing to find out, and why it matters.>

## Scope
Look in: <dirs, sources>. Do not: <edit files / run builds / spend tokens on X>.
Depth: <quick scan | thorough>. Stop when: <condition>.

## Already known (do not re-derive)
<facts you have>

## Report
At most <N> lines. Conclusions first, each with file:line or URL evidence.
Separate what you verified from what you infer. Say what you did not check.
```

Give parallel read-only lanes **disjoint** scopes (by directory, by source, by
hypothesis). Overlapping scopes are the main way research fan-outs waste
tokens: three workers find the same file and report it three times.

## Report schema (final message of every writing lane)

```markdown
STATUS: done | partial | blocked
BRANCH: <branch>   SHA: <full sha of pushed head>   PUSHED: yes | no
CHANGED: <files, grouped; one line each with the why if not obvious>
GATE:
- <command> → pass | fail (<one-line reason>)
NOT VERIFIED: <what the gate does not cover that this change could break —
  e.g. "no iOS build on Linux", "live e2e needs shared DB", "prod config">
OUTSIDE MY OWNERSHIP: <changes needed in files I do not own, with the diff
  or a precise description>
DECISIONS: <judgment calls made, alternatives rejected>
FOLLOW-UPS: <second problems noticed and deliberately not fixed here>
BLOCKER: <only if blocked: exact command, exact error, what I need>
```

When the Workflow tool runs the lanes, express the same schema as a JSON
`schema` on each `agent()` call so the orchestrator receives typed output
instead of prose.

## Brief review — ask before launching

- Could a stranger do this without asking anything? If not, what would they ask?
- Does any file appear in two lanes' "you own"? That is a planned conflict.
- Is every gate command safe in parallel? Anything touching a shared DB,
  fixed port or device is not.
- Is "done" checkable from outside (a SHA, a green command), not a feeling?
- Did you tell it what *not* to do, including not to fix the adjacent bug?
