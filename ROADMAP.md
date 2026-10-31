# Roadmap

What comes next, and in what order. It is the third document of the Apex
constitution, beside `MISSION.md` (what Apex is) and `TECHSTACK.md` (what it is
built on). It orders work and nothing else: what an item delivers lives in its
feature folder (`docs/specs/<slug>/`) or its board brief. A board orders the
work inside it ([iOS](docs/ios/MASTER.md), [onboarding](docs/onboarding/MASTER.md));
this file orders work across boards and wins where they disagree. The
improvement docs (`docs/improvements/01`–`03`) are sources that items are drafted
from, not a second roadmap: a section not cited here is not scheduled.

It changes only in a `Replan after <feature>` PR
([Replanning](docs/workflow-essentials.md#replanning)), held for Shane's `shipit`.

## Objective

**30 weekly-active athletes on iOS.** Active means at least one workout logged
through the iOS app in the trailing seven days: tracked, spoken or imported from
Apple Health. Thirty is where Apex stops being one athlete's log and becomes a
product, and where `TECHSTACK.md` moves the API to Vercel Pro. Every Now item
answers one question: does it bring Apex closer to thirty?

## Rules

- **The automation cap.** Now holds at most one item that builds Apex's own
  machinery: merge policy, CI, the owner loop, agent tooling. A red check or a
  broken gate is a repair, not an item; it goes first and takes no slot.
- **Sports, in tiers.** Tier 1 is lifting, running and biking, held to the same
  depth. Tier 2 follows in order: climbing, alpinism, swimming. Mountain biking
  is biking with a trail-difficulty field, not a sport of its own.
- An item enters Now with a feature folder or board brief, or its first PR
  writes one. A bug, a chore or a one-PR fix needs no entry here.

## Now

1. **Measure the objective.** The API receives `X-Apex-Client` on every iOS
   request and keeps none of it. Record which client logged each workout, and
   have `scripts/supervisor-report.sh` print the weekly-active count.
2. **App Store 1.0.** Rejected 2026-10-09 (2.1, Information Needed) and not
   resubmitted. Shane's steps are in [app-store.md §3](docs/ios/app-store.md),
   plus the license agreement Apple updated on 2026-10-13, which blocks
   submission until accepted. The review notes still call the app invite-only;
   open sign-up (#452) ended that.
3. **Apple Health, the read side.** W16 M2i (workouts in from any watch), then
   M3i and M4 ([W16](docs/ios/workstreams/W16-apple-health.md)). An athlete's
   history arrives on the first day.
4. **A weekly review without a key** (doc 2 §1b). A stranger from the App Store
   has no Anthropic key, and today the review answers 402.
5. **Endurance on par with lifting.** Runs and rides already log distance,
   elevation, time and heart rate, and set distance PRs. They lack what makes
   lifting worth tracking: a performance measure (pace, speed, fastest efforts
   at standard distances), structured intervals and progression. Biking gains
   trail difficulty. Folder: `docs/specs/endurance-parity/`.
6. **Voice logging, finished.** W17 M3 is Shane's device run on 1.1.0 (604),
   then default-on ([W17](docs/ios/workstreams/W17-voice-set-logging.md)).

**Automation slot:** ios-required M3, Shane's branch-protection flip
([spec](docs/specs/ios-required-check.md)).

## Next

- **Climbing, finished.** The deferred list in doc 1 §8, rechecked against
  `main`.
- **Timezones** (doc 3 §4). The server has no user timezone, so the reflection
  cron, MCP's date fallbacks and template copy count days in UTC.
- **COROS imports checked against Apple Health**, the gap `TECHSTACK.md` names.
- **Automation, one at a time through the slot:** agent-autonomy M3
  ([spec](docs/specs/agent-autonomy.md)), then owner loop M2 and M3
  ([spec](docs/specs/agent-ownership.md)).

## Later

- Alpinism, then swimming.
- A managed coach tier, the BYO-key exit, when Apex charges.
- Android, with Health Connect.
- Direct Garmin or Strava, only where Apple Health loses data.
- Sharing and roles (doc 3 §6).
