# Improvement doc 2 — coach and insight

**Date:** 2026-10-13 · **Status:** proposal · **Scope:** web + iOS + API + evals
**Source:** a feature-gap review of the whole repo against the product's own thesis — the coach is
handed computed facts, narrates, and proposes; nothing it proposes lands without confirmation.

The coach is the headline feature and the strongest engineering in the repo. From the user's
chair it is gated behind a developer-console sign-up, less capable in the app than over MCP, and
silent unless asked. Several numbers the app already computes are never shown. Items are ordered
by product impact; sizes as in doc 1 (S / M / L).

## 1. The API key is the wall — **P0 · decision, then L**

**Evidence.** Chat, the post-workout summary and the weekly review all answer 402 without a
personal Anthropic key ([chat.ts:444](../../api/chat.ts),
[coachSummary.ts:80](../../api/_lib/handlers/coachSummary.ts),
[weeklyReview.ts:19](../../api/_lib/handlers/weeklyReview.ts)). The onboarding brief targets "a
tech-illiterate adult on a phone" ([docs/onboarding/MASTER.md](../onboarding/MASTER.md)) and the
fourth welcome card sends that person to console.anthropic.com.

**The contradiction.** Those two goals cannot both hold. Options, in order of preference:
1. **Hosted key with a quota.** A server key behind the existing per-user rate limits and the
   200/day mutation cap; BYOK stays as an override for heavy users. Cost is bounded by the caps
   already in [rateLimit.ts](../../api/_lib/rateLimit.ts). Needs a pricing or invite-tier decision.
2. **Subscription OAuth** — researched in onboarding lane O06 and rejected for now (D-O06).
3. **Keep BYOK and drop the non-technical audience** from every doc and card.

Whatever is chosen, the stats-only fallbacks should widen: a weekly review *without* prose
(plan-vs-done, physiology numbers, PRs) needs no key and is most of the value.

## 2. Capability asymmetry: chat vs MCP — **P0 · M**

**Evidence.** In-app chat has 11 write tools, all behind confirm cards
([tools.ts:753](../../src/lib/coach/tools.ts)). MCP has 23
([writeTools.ts:739](../../api/_lib/mcp/writeTools.ts)) and runs them *without* a card. Only MCP
can `complete_workout`, `uncomplete_workout`, `log_workout`, create/update/delete blocks and
objectives, `update_profile` (goal, context, HR), and `dismiss_note`. The README's "24" is off by
one; `search_history` is in-app only.

**User sees.** "Mark today done" or "log 5×5 at 225" in the sidebar gets an apology; the same
sentence in Claude Desktop just happens, unreviewed.

**Fix.** Register the eight MCP-only tools in `COACH_TOOLS` with confirm cards and preview labels
(the executors already exist in `serverDeps`). Add eval cases for each (the suite has none for
`leave_note` or `propose_contract_edit` either). Separately decide whether MCP writes should get
an "undo last N" surface in Coach activity, since they have no card.

## 3. Bulk confirm and whole-plan proposals — **P1 · M**

**Evidence.** A multi-week plan arrives as N separate `create_event` cards confirmed one at a
time, then at most 3 tools-on follow-up rounds ([useChat.ts:311](../../src/hooks/useChat.ts)). The
planner drafts 1–24 blocks but never the workouts inside them
([schemas.ts:523](../../src/lib/coach/schemas.ts)).

**Fix.** A grouped card: "Create 24 workouts across 8 weeks — Review · Confirm all · Cancel",
with the per-item list expandable. Server side, a `batch` wrapper over the action queue that
commits atomically or not at all. Let the planner emit a workouts draft per block that the same
grouped card applies.

## 4. Nothing reaches the user unprompted — **P0 · L**

**Evidence.** No reminders, missed-workout nudge or streak anywhere (web, iOS, email). Reflection
is opt-in, off by default, and writes proposals into a notebook with no badge
([reflectionCron.ts:11](../../api/_lib/handlers/reflectionCron.ts)). The only emails are the
monthly/yearly review and a cap alert ([mailer.ts](../../api/_lib/mailer.ts)); APNs ends a Live
Activity and nothing else ([apns.ts:5](../../api/_lib/apns.ts)). Push is iOS backlog D-017.

**Fix.** One notification channel first, then the events that use it.
- Channel: `device_tokens` + `/api/devices` + an APNs alert sender (D-017's shape); email
  as the web fallback with per-kind opt-out on the profile.
- Events, in value order: tonight's workout at a chosen time; a workout left unlogged by end of
  day; reflection proposals waiting; a PR or block milestone; the weekly review is ready.
- In-app: a badge on Profile when the notebook has unreviewed proposals (S, do it now).

## 5. Thread management — **P1 · S–M**

**Evidence.** The web loads only the newest thread per mode
([useChat.ts:435](../../src/hooks/useChat.ts)); the API supports list/rename/delete
([coachConversations.ts:19](../../api/_lib/handlers/coachConversations.ts)) but no UI calls them.
Coach's Notes replaces the visible thread. Saves stop silently at 80 rows; chat errors past ~160
messages. iOS threads are local and never meet the web's (D-013 backlog).

**Fix.** A thread list in the sidebar header (newest 20, rename, delete), Coach's Notes into its
own thread, a visible "thread is full — start a new one" state, and the iOS sync D-013 already
specifies.

## 6. Computed insight that is never shown — **P1 · M**

**Evidence.** `src/lib/physiology/` computes acute:chronic load, HRV 7d vs 28d, zone minutes and
weekly tonnage for five weeks ([types.ts:58](../../src/lib/physiology/types.ts)). It reaches the
user only as AI prose in the weekly review — which needs a key, is regenerated on every open,
is never stored ([weekly.ts:11](../../src/lib/review/weekly.ts)), and computes physiology as of
*today* even when viewing an old week ([api weekly.ts:182](../../api/_lib/review/weekly.ts)).
Monthly and yearly reviews are stored but readable only via MCP
([tools/reviews.ts](../../api/_lib/mcp/tools/reviews.ts)).

**Fix.**
- A "Load" panel (or four analytics measures: `acwr`, `hrv`, `zone-minutes`, `tonnage-week`)
  that renders the physiology numbers with no key — this is the product thesis made visible.
- Store weekly reviews (`reviews` table already has `period_type`); pass the week's end date, not
  today, as the physiology anchor.
- A Reviews page in Profile listing stored monthly/yearly/weekly documents.

## 7. Analytics blind spots — **P2 · S each, M for body weight**

Missing measures: body weight (needs doc 1 §1's entry), resting HR / sleep (needs an import,
doc 3 §1), muscle-group volume (a `muscle-group` group-by over definitions — the data exists),
PR timeline (from `computePeriodPRs`), consistency/streak (from completions). HR-zone tiles read
device streams only ([analyticsData.ts:76](../../api/_lib/analyticsData.ts)); fold in hand-entered
average HR the way physiology already does.

## 8. Blocks and library edges — **P2 · S–M**

- Objectives can be created only inside the cycle editor and never edited, deleted or marked
  achieved; the context functions exist, no component calls them
  ([BlocksContext.tsx:166](../../src/context/BlocksContext.tsx)). Wire them.
- No per-lift goal ("squat 315 by March"). Add `objective.targets[]` of `{definitionId, value,
  kind}` and show distance-to-goal on the exercise detail page.
- No built-in exercise catalog; a new account inherits only what the starter plan references
  ([templateCopy.ts:129](../../api/_lib/handlers/templateCopy.ts)). Ship a seed of ~150
  definitions with muscle groups and equipment, opt-in at onboarding.
- No duplicate merge; `image_url` cannot be set from any UI; equipment is not filterable.

## 9. Nutrition is half a feature — **P2 · decision**

Macros, favorites and day totals exist; no targets, no food database, no body-weight log, and the
coach has no target tool ([schemas.ts:250](../../src/lib/coach/schemas.ts)). Either add daily
targets (profile columns, a ring on the day modal, a coach tool) and a body-weight log, or demote
meals to a note-style quick entry. Half-built nutrition costs trust in the rest.

## 10. BYOK with no spend visibility — **P2 · S**

`coach_runs` records every call and is service-role only (phase45). Expose a 30-day token and
estimated-dollar total on the AI Coach section, per model.

## Sequencing

| Order | Item |
|---|---|
| 1 | §1 decision on the key (everything else assumes an answer) |
| 2 | §2 tool parity + evals; §4 notebook badge (S) |
| 3 | §6 physiology surface + stored weekly reviews |
| 4 | §3 grouped confirm |
| 5 | §4 notification channel |
| 6 | §5, §7, §8, §9, §10 as parallel lanes |

§4 (channel) and §6 (stored reviews) carry migrations and are HELD. Every change to `COACH_TOOLS`
or the prompt runs the eval gate before it merges (evals/README.md).
