# Improvement doc 2 — coach and insight

**Date:** 2026-10-13 · **Status:** proposal · reviewed 2026-10-14 · **Scope:** web + iOS + API + evals
**Source:** a feature-gap review of the whole repo against the product's own thesis — the coach is
handed computed facts, narrates, and proposes; nothing it proposes lands without confirmation.

The coach is the headline feature and the strongest engineering in the repo. From the user's
chair it is gated behind a developer-console sign-up, less capable in the app than over MCP, and
silent unless asked. Several numbers the app already computes are never shown. Items are ordered
by product impact; sizes as in doc 1 (S / M / L).

## 1. The API key is the wall — **P0 · decision, then L+**

**Evidence.** Chat, the post-workout summary and the weekly review all answer 402 without a
personal Anthropic key ([chat.ts:445](../../api/chat.ts),
[coachSummary.ts:80](../../api/_lib/handlers/coachSummary.ts),
[weeklyReview.ts:77](../../api/_lib/handlers/weeklyReview.ts)). The onboarding brief targets "a
tech-illiterate adult on a phone" ([docs/onboarding/MASTER.md](../onboarding/MASTER.md)); the
fourth welcome card ([content.ts:71](../../src/lib/onboarding/content.ts)) links to the in-app
`/help/get-api-key` page ([help/get-api-key.md](../../help/get-api-key.md)), which then sends that
person to console.anthropic.com — two hops to a developer console.

**What bounds cost today.** Less than it looks. `AI_DAILY_MUTATION_CAP` = 200
([rateLimit.ts:106](../../api/_lib/rateLimit.ts)) counts AI-made *writes* only (coach-tool, MCP,
and the AI-stamped paths of events, meals and exercise definitions). Model calls are only
throttled ([rateLimit.ts:31](../../api/_lib/rateLimit.ts)): chat 30 per 10 minutes (about 4,300 a
day), summary 10 per hour, weekly review on the shared `writes` bucket at 120 per hour. There is
no token or dollar cap, and the limiter fails open on a DB error
([rateLimit.ts:70](../../api/_lib/rateLimit.ts)). The default model is Opus 5.5
([models.ts:65](../../src/lib/coach/models.ts)) with chat `max_tokens` 8192
([chat.ts:577](../../api/chat.ts)).

**The contradiction.** Those two goals cannot both hold. The real decision is a **per-user monthly
dollar budget** — what Apex will spend on one user — not "hosted vs BYOK". Options, in order of
preference:
1. **Hosted key with a budget.** A server key; BYOK stays as an override for heavy users. Needs,
   before it is safe: every model call recorded in `coach_runs` (see §10 — today only chat is), a
   per-user daily token budget checked before each call and failing *closed*, and a forced cheaper
   model on the hosted path. Size L+, plus a pricing or invite-tier decision.
2. **Subscription OAuth** — D-O06 ([decisions.md:66](../onboarding/decisions.md)) is still
   **open**. The O06 research found consumer-subscription OAuth for third-party apps expressly
   prohibited and recommends research only, no build; Shane has not confirmed. Close it.
3. **Keep BYOK and drop the non-technical audience** from every doc and card.

## 1b. Stats-only weekly review — **P0 · S–M, ships whatever §1 decides**

A weekly review *without* prose (plan-vs-done, physiology numbers, PRs) needs no key and is most
of the value. The pattern already exists: the monthly/yearly email goes stats-only for users
without a key ([review-cron.ts:42](../../api/review-cron.ts),
[stats.ts](../../src/lib/review/stats.ts)). Do the same for the weekly review instead of a 402.

## 2. Capability asymmetry: chat vs MCP

**Evidence.** In-app `COACH_TOOLS` has 12 write tools counting `memory`, all behind confirm cards
([tools.ts:753](../../src/lib/coach/tools.ts)). MCP has 23
([writeTools.ts:739](../../api/_lib/mcp/writeTools.ts)), exposed only to `mcp:write` tokens,
counted against the 200/day cap, and run *without* a card. Eleven are MCP-only:
`complete_workout`, `uncomplete_workout`, `log_workout`, create/update/delete training block,
create/update/delete objective, `update_profile` (goal, context, HR) and `dismiss_note`.
(`update_coach_memory` is also MCP-only by name; chat covers it with `memory`.) The README's "24"
is off by one; `search_history` is in-app only.

**User sees.** "Mark today done" or "log 5×5 at 225" in the sidebar gets an apology; the same
sentence in Claude Desktop just happens, unreviewed.

**Not free to port.** `createServerDeps` ([serverDeps.ts:37](../../api/_lib/coach/serverDeps.ts))
covers only the existing chat ops. The MCP-only tools are self-contained `run()` functions in
`writeTools.ts`, so chat needs new `CoachToolDeps` methods (or the logic moved into shared
services both doors call).

**Eval gap.** Wider than "no cases for the new tools". There are no positive cases for
`create_exercise_definition`, `update_exercise_definition`, `log_meal`, `update_meal` or
`delete_meal`; `leave_note` and `propose_contract_edit` appear only on forbidden-tool lists
([planner.ts:149](../../evals/cases/planner.ts)). Any new chat tool is automatically forbidden in
the existing sight cases ([sight.ts](../../evals/cases/sight.ts) builds its list from the schemas)
and moves the eval surface hash, so every tool PR runs the gate.

### 2a. Complete and log from chat — **P0 · M**

Register `complete_workout` and `log_workout` (and `uncomplete_workout` as their undo) in
`COACH_TOOLS` with confirm cards and preview labels, new deps methods, and positive eval cases.

### 2b. The rest of parity — **P2**

Blocks, objectives, `update_profile`, `dismiss_note`, same pattern. Separately decide whether MCP
writes should get an "undo last N" surface in Coach activity, since they have no card.

## 3. Bulk confirm and whole-plan proposals — **P1 · M**

**Evidence.** A multi-week plan arrives as N separate `create_event` cards confirmed one at a
time, then at most 3 tools-on follow-up rounds ([useChat.ts:311](../../src/hooks/useChat.ts)). The
planner drafts 1–24 blocks but never the workouts inside them
([schemas.ts:525](../../src/lib/coach/schemas.ts)). Each card is its own `/api/coach-tool` call,
and each counts against the 200/day cap ([coachTool.ts:120](../../api/_lib/handlers/coachTool.ts)),
so a 24-card plan can fail partway.

**Fix.** A grouped card: "Create 24 workouts across 8 weeks — Review · Confirm all · Cancel",
with the per-item list expandable. Server side, a batch route that commits atomically or not at
all and counts once against the cap; events plus their exercises span tables, so it needs a
transactional RPC. The only atomic batch today is the block cycle commit, a single-table insert
([trainingBlocks.ts:151](../../api/_lib/trainingBlocks.ts), fed by
[blockCycle.ts](../../api/_lib/handlers/blockCycle.ts)). Let the planner emit a workouts draft per
block that the same grouped card applies.

## 4. Nothing reaches the user unprompted — **P0 · L**

**Evidence.** No reminders, missed-workout nudge or live streak anywhere (web, iOS, email); a
longest-streak stat exists only inside the review email
([stats.ts:239](../../src/lib/review/stats.ts)) — reuse it. Reflection is opt-in, off by default
([reflectionCron.ts:83](../../api/_lib/handlers/reflectionCron.ts)), and writes proposals into a
notebook with no badge. The only emails are the monthly/yearly review and a cap alert
([mailer.ts](../../api/_lib/mailer.ts)); APNs ends a Live Activity and nothing else
([apns.ts:5](../../api/_lib/apns.ts)). Push is iOS backlog D-017.

**Fix.** One notification channel first, then the events that use it.
- Channel: `device_tokens` + `/api/devices` + an APNs alert sender (D-017's shape); email
  as the web fallback with per-kind opt-out on the profile.
- Events, in value order: tonight's workout at a chosen time; a workout left unlogged by end of
  day; reflection proposals waiting; a PR or block milestone; the weekly review is ready.
- In-app: a badge on Profile when the notebook has unreviewed proposals (S, do it now).

## 5. Thread management — **P1 · S–M**

**Precondition.** Confirm the Privacy Policy gate on `coach_messages` storage
([backend-changes.md:410](../ios/backend-changes.md)) has been cleared before any thread work.

**Evidence.** The web loads only the newest thread per mode
([useChat.ts:432](../../src/hooks/useChat.ts)); the API supports list/rename/delete
([coachConversations.ts:19](../../api/_lib/handlers/coachConversations.ts)) but no UI calls them.
Coach's Notes replaces the visible thread. Saves stop silently at 80 rows; chat errors past ~160
messages. iOS threads are local by design — D-013 *chose* that — and the iOS sync to the server
table is the backlog item ([MASTER.md:118](../ios/MASTER.md)). iOS already has a thread list with
new / resume / delete ([screens.md:34](../ios/screens.md)) that the web can copy.

**Fix.** A thread list in the sidebar header (newest 20, rename, delete), modelled on the iOS
one; Coach's Notes into its own thread; a visible "thread is full — start a new one" state; and
the iOS sync from the backlog.

## 6. Computed insight that is never shown — **P1 · M**

**Evidence.** `src/lib/physiology/` computes acute:chronic load, HRV 7d vs 28d, zone minutes and
weekly tonnage for five weeks ([types.ts:52](../../src/lib/physiology/types.ts)). It reaches the
user only as AI prose in the weekly review — which needs a key, is regenerated on every open
(a model call each time, a cost tied to §1), is never stored
([weekly.ts:11](../../src/lib/review/weekly.ts)), and computes physiology as of *today* even when
viewing an old week ([api weekly.ts:149](../../api/_lib/review/weekly.ts)). Monthly and yearly
reviews are stored, emailed ([review-cron.ts](../../api/review-cron.ts)) and read by the in-app
coach via `getReviewsTool` ([readTools.ts:21](../../api/_lib/coach/readTools.ts)); what is missing
is an in-app Reviews page.

**Fix.**
- A "Load" panel (or four analytics measures: `acwr`, `hrv`, `zone-minutes`, `tonnage-week`)
  that renders the physiology numbers with no key — this is the product thesis made visible.
- Store weekly reviews. `reviews.period_type` is `CHECK IN ('month','year')`
  ([phase12_reviews.sql:15](../../supabase/migrations/phase12_reviews.sql)) and `month_index` is
  tied to it (:26), so this needs a migration (HELD). Pass the week's end date, not today, as the
  physiology anchor.
- A Reviews page in Profile listing stored monthly/yearly/weekly documents.

## 7. Analytics blind spots — **P2 · S each, M for body weight**

Missing measures: body weight (doc 1 §1 shipped a single `profiles.body_weight_lb` scalar,
#417/#420, with no history), muscle-group volume (a `muscle-group` group-by over definitions — the
data exists), PR timeline (from `computePeriodPRs`), consistency/streak (from completions).
Resting HR, sleep, HRV and body mass are now owned by W16
([W16-apple-health.md](../ios/workstreams/W16-apple-health.md): `daily_metrics`, M0 and M3, not
yet built); W16 feeds the coach's physiology block but plans no analytics measures, so the
measures stay here, after W16 M0. HR-zone tiles read device streams only
([analyticsData.ts:77](../../api/_lib/analyticsData.ts)); fold in hand-entered average HR the way
physiology already does. Each new measure edits `src/lib/coach/schemas.ts` and `prompt.ts`, which
are coach-gate files, so each runs the eval gate.

## 8. Blocks and library edges — **P2 · S–M**

- Objectives can be created only inside the cycle editor and never edited, deleted or marked
  achieved in the app on web or iOS. The capability exists — MCP can update, delete and set
  `achieved` ([writeTools.ts:593](../../api/_lib/mcp/writeTools.ts)), and the context functions
  exist with no component calling them ([BlocksContext.tsx:166](../../src/context/BlocksContext.tsx)).
  The gap is UI. Wire it.
- No per-lift goal ("squat 315 by March"). Add `objective.targets[]` of `{definitionId, value,
  kind}` and show distance-to-goal on the exercise detail page.
- No built-in exercise catalog; a new account inherits only what the starter plan references
  ([templateCopy.ts:129](../../api/_lib/handlers/templateCopy.ts)). Ship a seed of ~150
  definitions with muscle groups and equipment, opt-in at onboarding.
- No duplicate merge; `image_url` cannot be set from any UI; equipment is not filterable.

## 9. Nutrition is half a feature — **P2 · decision**

Macros, favorites and day totals exist; no targets, no food database, no body-weight log, and the
coach has no target tool ([schemas.ts:249](../../src/lib/coach/schemas.ts)). Either add daily
targets (profile columns, a ring on the day modal, a coach tool) and a body-weight log, or demote
meals to a note-style quick entry. Half-built nutrition costs trust in the rest.

## 10. BYOK with no spend visibility — **P2 · S, after instrumentation**

`coach_runs` is service-role only (phase45) and records chat alone: only
[chat.ts](../../api/chat.ts) writes it, via [coachRuns.ts](../../api/_lib/coachRuns.ts). The
summary, weekly review, reflection and monthly/yearly recap record nothing, so instrument them
first; the `mode` CHECK (phase51: chat/builder/analytics/planner) needs a migration to admit them.
Then expose a 30-day token and estimated-dollar total on the AI Coach section, per model.

## Sequencing

| Order | Item |
|---|---|
| 0 | Re-attest the coach eval gate (`npm run eval:gate`). The attestation is from 2026-10-06 and #425 bypassed it, so §2/§3 PRs fail `coach-gate` until then. |
| 1 | §1 budget decision + close D-O06; in parallel: §1b stats-only weekly review, §4 notebook badge (S) |
| 2 | Record every model call in `coach_runs` (prerequisite for a hosted §1 and for §10) |
| 3 | §2a complete/log tools + positive evals; §6 physiology numbers shown without a key |
| 4 | §6 stored weekly reviews (migration, HELD) + Reviews page; §1 budget if hosted |
| 5 | §3 grouped confirm + transactional batch route |
| 6 | §4 notification channel (HELD) |
| 7 | §2b, §5, §7 (after W16 M0), §8, §9, §10 UI as parallel lanes |

**In flight (2026-10-14):** `feat/weekly-review-keyless` (stats-only weekly review + physiology
section + week-end anchor), `feat/notebook-badge`, `db/coach-runs-all-calls`.

§4 (channel), §6 (stored reviews) and §10 (`mode` CHECK) carry migrations and are HELD. Every
change to `COACH_TOOLS` or the prompt runs the eval gate before it merges (evals/README.md).
