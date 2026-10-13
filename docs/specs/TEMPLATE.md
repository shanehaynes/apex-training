# <Title> — spec

Copy this file to `docs/specs/<slug>.md` for any piece of work larger than one
PR that does not already live on a board (`docs/ios/`, `docs/onboarding/`).
It is the iOS workstream brief format (`docs/ios/workstreams/W06-coach-tab.md`),
which has landed fifteen workstreams; nothing here is new. A session's input is
this file; its instruction is **implement until every acceptance box is
checked and the gate is green**, one PR per milestone, the babysitter between
milestones. One bug is a ten-minute session; a spec is a multi-hour one.

**Owns:** <the files and directories this spec may change — a file in two
specs' ownership is a planned conflict>
**Forbidden:** gate-protected paths (tests the spec did not add, CI config,
hooks, `scripts/merge-policy.mjs`), plus <anything else>
**Depends on:** <specs or PRs that must merge first, or none>
**Status:** not started · in progress (branch) · in review (PR #) · done (PR #) · blocked on …

## Goal
<One paragraph: what exists when this is done, and why it is worth a spec.>

## Scope
In:
- <bullet per concern>
Out:
- <what a tempted session must not do; the next spec's job>

## Milestones
Each milestone is one PR. A milestone's acceptance list is what its session
checks off; a session does not open the next milestone's PR until the
previous one has merged (`scripts/merge-babysit.sh --yes` runs the loop).

### M1 — <name>
- [ ] <acceptance criterion: observable, testable, no adjectives>
- [ ] <…>

### M2 — <name>
- [ ] <…>

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it). Plus:
<anything the gate cannot prove — a device run, a live-stack e2e, a
screenshot — and who proves it>.

## Done means
Every box above checked, every PR merged, `scripts/git-tidy.sh --yes` run,
and the Next brief section below filled in.

## Decisions
<Judgment calls made where this spec left room, one line each, newest last.
Boards have their own decisions file; a spec keeps them here.>

## Session log
- <YYYY-MM-DD> · <what landed, PR #, what was not verified, what was decided>

## Next brief
<Required last output of every session on this spec: the draft of the next
milestone's brief, or of the next spec — Goal, Scope, Acceptance, Owns —
concrete enough for a session with no memory of this one. Shane edits it; he
does not write it from blank.>
