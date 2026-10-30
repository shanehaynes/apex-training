# <Feature> — plan

How `requirements.md` gets built, in what order, and by whom. A session's
instruction is **implement until every milestone box is checked and every
`validation.md` row is proven**, one PR per milestone, the babysitter between
milestones.

**Owns:** <the files and directories this feature may change; a file in two
features' ownership is a planned conflict>
**Forbidden:** gate-protected paths (tests this feature did not add, CI config,
hooks, `scripts/merge-policy.mjs`), plus <anything else>
**Depends on:** <features or PRs that must merge first, or none>
**Status:** not started · in progress (branch) · in review (PR #) · shipped (PR #) · blocked on …

## Approach
<The design in a few paragraphs: data model, API, client surfaces. Name any
`TECHSTACK.md` row this touches or strains.>

## Milestones
Each milestone is one PR. A session does not open the next milestone's PR
until the previous one has merged (`scripts/merge-babysit.sh --yes`).

### M1 — <name>
Delivers: R1, R2
- [ ] <acceptance criterion: observable, testable, no adjectives>

### M2 — <name>
Delivers: R3
- [ ] <…>

## Decisions
<Judgment calls made where the requirements left room, one line each, newest
last.>

## Session log
- <YYYY-MM-DD> · <what landed, PR #, what was not verified, what was decided>

## Next brief
<Required last output of every session on this feature: the draft of the next
milestone's brief, or of the next feature, concrete enough for a session with
no memory of this one. Shane edits it; he does not write it from blank.>
