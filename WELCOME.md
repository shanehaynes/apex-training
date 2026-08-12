# Welcome to Apex Training

Plan your training on a calendar, log it as you go, and let a coach that reads your
actual numbers help you steer.

This is the whole app, one short section each. Nothing here is required reading — the
**Getting started** checklist in **Profile** (the avatar, top left) tracks the handful of
things worth setting up, and ticks them off as you do.

---

## The calendar

The home screen. Month, week, or day on a desktop; on a phone, always one day at a time.

Tap a day to see what's on it and to add a workout or a meal. A workout can repeat on a
rule — every Tuesday, every other Thursday — and you can skip or edit a single occurrence
without touching the rest of the series.

New accounts get offered a **starter plan**: a copy of Shane's recurring workouts, as a
base to edit or delete. It's a one-time copy, and skipping it costs nothing.

## Logging a workout

Open a workout and press **Start Workout**.

- Log each set against what was planned. Last session's numbers sit next to each set —
  tap to reuse them.
- Sets you never touch are recorded as zeros rather than quietly dropped, so your history
  reflects what actually happened.
- Finishing shows a summary, including any **personal records**: heaviest estimated 1RM
  (Epley), longest duration, most reps, furthest distance, most elevation. Your first
  time logging a movement is never a PR — there's nothing to beat yet.

In a hurry, **Mark as Complete** records the session without opening the tracker.

## Your coach

The chat rail on the right (on a phone, the second tab). Ask it anything about your
training — it can see today's workouts, this week's schedule, your recent completion
rate, your exercise library, your active training block, and today's meals.

- **Coach's Notes** gives you a daily briefing in one tap.
- It can also **make changes** — create and edit workouts, set a session's exercises,
  log and edit meals. Every one of those arrives as a Confirm/Cancel card first; nothing
  changes until you say so. **Profile → Coach activity** logs everything it did.
- Tell it your **goal** and anything it should know about you in **Profile → AI Coach**.
  One line each, and it shapes every answer you get.

**The coach needs your own Anthropic API key.** Chat and post-workout summaries stay
switched off until you add one in **Profile → AI Coach**. Get a key at
[console.anthropic.com](https://console.anthropic.com/) — usage bills to your account,
not to Apex.

## Training blocks

A block is a dated stretch of training with weekly targets — it's what lets the coach say
"92% of planned aerobic volume" instead of "7 hours." Blocks are Monday-aligned and can't
overlap.

The **cycle generator** lays down a whole periodized cycle in one form — 3 weeks on, 1
week easy, by default — and shows you the dated preview before it commits. You can attach
a named **objective** with a target date, then watch attainment bars fill in per target,
for this week and for the block so far.

## Exercise library

Every movement you've logged, searchable and filterable by category, with archived ones
tucked out of the way. Open one for its history, a progress chart, and recent sessions.

Names are alias-aware: "cable row" and whatever else you've called it resolve to the same
exercise, so history and PRs don't fragment.

## Meals

Add a meal from any day. Pick a type and time, enter protein/carbs/fat, and calories
derive themselves unless you type over them. Save one as a **favorite** to re-add it in a
tap. Each day shows its macro totals, and the coach sees today's meals — so it can talk
about fueling alongside training.

## Watch sync (COROS)

Connect a COROS account in **Profile → COROS**. You sign in on COROS's own site; Apex
never sees your COROS password.

After that it **syncs itself every night**, around 11:30 PM Eastern:

- Activities that don't match anything planned import on their own, as completed events.
- An activity that **does** match a planned workout is never filled in automatically. It
  waits, the **Sync** button above the calendar wears a badge with the count, and you
  decide per activity: **Fill it** completes the planned workout with your measured data,
  or **Keep separate** imports it as its own event. Either way your planned targets stay
  put — actuals live beside them, and count toward PRs like anything you logged by hand.
- Distance, elevation, average and max heart rate, and calories come along. The workout
  detail draws a heart-rate chart, an elevation profile, and a route outline — all
  rendered locally, so your GPS coordinates never go to a map-tile service.
- You can press **Sync** yourself any time. Duplicates are impossible; syncing twice just
  reports that everything is up to date.

Prefer to sync only by hand? Turn off the nightly toggle in **Profile → COROS**.
Disconnecting keeps everything already imported.

## Claude, ChatGPT, and other assistants

Apex can be connected as a tool to an AI assistant, so you can ask about your training
from wherever you already are.

**It is strictly read-only.** An assistant can look at your schedule, workouts, exercise
history, PRs, period stats, training blocks, and meals — and change nothing. Anything
that writes stays in the in-app coach, behind a confirmation.

Set it up in **Profile → AI connector**. Claude Desktop, claude.ai, and ChatGPT connect
over OAuth with just the endpoint URL; Claude Code and other header-based clients use a
personal access token you mint there. Per-client walkthroughs, including ChatGPT's
paid-plan and developer-mode requirements, are in [CONNECTORS.md](CONNECTORS.md).

The same screen lists every token and connected app, and revokes any of them.

## Calendar feed

**Profile → Calendar feed** gives you a URL to subscribe to from Apple Calendar, Google
Calendar, or anything else that takes an ICS feed. Treat it like a password — anyone with
the URL can read your schedule.

## Review emails

When a training month closes, a review of it lands in your inbox: sessions by type,
training time, weight moved, distance, elevation, streaks, and PRs. There's a yearly one
too. If you've saved an Anthropic key, it comes with a short note from your coach;
otherwise you get the numbers.

A "month" here is four ISO weeks, so there are 13 of them a year — which is why the
review dates won't line up with calendar months.

## On a phone

Two tabs at the bottom: **Calendar** and **Analytics** — the second one is your coach
chat. The calendar shows a single day at a time; widen the window on a desktop and month
or week comes back.

---

Something not working, or not covered here? The full technical picture lives in
[README.md](README.md).
