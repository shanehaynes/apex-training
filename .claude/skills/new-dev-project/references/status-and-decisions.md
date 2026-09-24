# Status board and decision log

Two files that let the next session inherit state instead of rediscovering it.
Both are shared state: `STATUS.md` is a hot file every session edits, and a
numbered decision log would be a global counter. The formats below are chosen
so neither becomes a collision.

## STATUS.md

```markdown
# Status

_Updated <YYYY-MM-DD> by <branch or session>._

## Workstreams
| Workstream | Branch / claim | State | Next step |
|---|---|---|---|
| Day-0 setup | chore/day0 | done | — |
| <name> | <branch> | not started · in progress · in review · blocked (why) · done | <one concrete action> |

## Pending for <the user>
- [ ] <e.g. apply merge settings — checklist in the new-dev-project skill>
- [ ] <e.g. set PROD_API_KEY in Vercel production env>

## Known gaps
- <e.g. Bash guard not mechanized; rules are prose in CLAUDE.md>
- <what CI does not cover>
```

Keep the conflict surface small: **one row per workstream, and a session edits
only its own row** (plus adding a row). Two lanes touching different rows merge
cleanly; the "Updated" line is the only shared line, and when it conflicts,
either side is fine.

**Session protocol** — the four lines that go into `CLAUDE.md`'s "Start here":
1. Read `CLAUDE.md`, then `STATUS.md`.
2. Claim your work: `lane.sh new …` and add or update your row.
3. Before ending: update your row (state, next step), and record any decision
   you made.
4. If you leave work unfinished, the next step in your row must be concrete
   enough for a session with no memory of yours.

**Growing it** (earned tier — a second concurrent workstream): move to a
master doc like `docs/<area>/MASTER.md` — vision, principles, a decisions
table, a roadmap with gates between workstreams ("backend merged before the
client starts"), and one self-contained brief per workstream with its own log.
The Apex iOS port's `docs/ios/MASTER.md` is the worked example: read the
master doc, the board, and exactly one workstream brief; claim the
workstream; before ending, update its log, the board and the decisions.

## Decision records

One file per decision: `docs/decisions/YYYY-MM-DD-<slug>.md`. Named by date
and slug, never by a sequence number — a number is a global counter two
parallel sessions would both claim; a date+slug is a partition, so there is
nothing to claim. `ls` still sorts them in order.

```markdown
# <Decision, stated as the choice made>

Date: <YYYY-MM-DD> · Status: accepted | superseded by <file>

## Context
<What forced a decision now; the constraint that matters most.>

## Options
- **<A>** — <pros> / <cons>
- **<B>** — <pros> / <cons>

## Decision
<The choice, and the one or two reasons that decided it.>

## Revisit when
<The observable trigger that would reopen this.>
```

**Day-0 records**, in this order:
1. `…-project-stakes.md` — the four step-0 answers and what they imply.
2. `…-stack.md` — the stack, and the defaults deliberately not taken.
3. `…-merge-settings.md` — squash/strict/auto-delete, or the deviation and why.
4. `…-deploy-target.md` — the target, or "none yet" and its trigger.

"Revisit when" is the section that earns its place. A decision without a
trigger is either permanent or forgotten; naming the trigger turns it into the
same kind of deferred-but-scheduled work as the earned tier.
