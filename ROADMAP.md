# Roadmap

The third constitution document: what comes next, in order. An item is a name,
a reason and a link; what it delivers and where it stands live in its feature
folder (`docs/specs/<slug>/`) or board brief. A board orders the work inside it;
this file orders work across boards and wins where they disagree.

It changes in a `Replan after <feature>` PR
([Replanning](docs/workflow-essentials.md#replanning)). A Now item that is not a
feature is struck by the PR that finishes it, or, when it finishes outside a PR
(a release, a protection flip), by the next roadmap PR. Every change is held for
Shane's `shipit`; git keeps what shipped.

## Objective

**30 weekly-active athletes on iOS.** Active means at least one completed
workout dated in the trailing seven days and logged through the iOS app:
tracked, spoken or imported from Apple Health. Thirty is where Apex stops being
one athlete's log and becomes a product, and where `TECHSTACK.md` moves the API
to Vercel Pro. Every Now item but the automation slot answers one question: does
it bring Apex closer to thirty?

## Rules

- **The automation cap.** Now holds at most one item whose purpose is Apex's
  own machinery: merge policy, CI, the owner loop, agent tooling. A feature that
  touches those files is not one. A red check or a broken gate is a repair, not
  an item; it goes first and takes no slot.
- **Sports, in tiers.** Tier 1 is lifting, running and biking, held to the same
  depth. Tier 2 follows in order: climbing, alpinism, swimming. Mountain biking
  is biking plus a trail-difficulty field.
- **Scope.** Shane's direct request outranks this order; it binds the work an
  agent picks for itself. Lanes already open finish; nothing new starts outside
  Now. A one-PR fix needs no entry. Larger work drawn from `docs/improvements/`
  needs one.

## Now

1. **App Store 1.0.** Strangers cannot reach a TestFlight build. Rejected
   2026-10-09 and not resubmitted; which build goes back is Shane's call
   ([STATUS](docs/ios/STATUS.md), [app-store.md](docs/ios/app-store.md) §3, §7).
2. **Apple Health, the rest of W16.** Every run and ride from any watch, and the
   last 30 days on connect. The privacy bump (Shane), then M2i, M3i, M4
   ([W16](docs/ios/workstreams/W16-apple-health.md)).
3. **Measure the objective.** Nothing counts weekly-active athletes, and
   `legal/privacy-v1.md` promises no analytics. Shane decides how to count
   before any code.
4. **Endurance on par with lifting.** Runs and rides have distance and elevation
   PRs but no performance measure (pace, speed, fastest efforts at standard
   distances), structured intervals or progression. Feature folder to write.
5. **Voice logging, finished.** W17 M3, Shane's device run, then default-on
   ([W17](docs/ios/workstreams/W17-voice-set-logging.md)).

**Automation slot:** ios-required M3, Shane's protection flip
([spec](docs/specs/ios-required-check.md)).

## Next

- **The weekly review on iOS.** It works without a key on the web (#446); iOS
  has no review screen.
- **Climbing, finished.** Doc 1 §8's deferred list, rechecked against `main`.
- **COROS imports checked against Apple Health**, the gap `TECHSTACK.md` names.
- **Automation, one at a time through the slot:** owner loop M2 and M3
  ([spec](docs/specs/agent-ownership.md)).

## Later

- Alpinism, then swimming.
- A managed coach tier, the BYO-key exit, when Apex charges.
- Android, with Health Connect.
- Direct Garmin or Strava, only where Apple Health loses data.
- Sharing and roles (doc 3 §6).
