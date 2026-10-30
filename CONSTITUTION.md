# The Apex Constitution

What Apex is, whom it serves, and what it will not do. Every spec, feature and
session answers to this document; where a request conflicts with it, the
document wins and the conflict is raised, not resolved quietly.

## What we believe

Fitness is the strongest lever most people have on their health, and it is one
of the best things people do together: the long ride, the shared rope, the
start line at dawn. Apex exists to serve that.

## Mission

Apex is the one place an athlete needs to pursue a sport or fitness goal, from
logging a first PR to building toward an Ironman. It asks of each athlete only
as much as they choose to give.

## Who it serves

Athletes: anyone training toward something specific. Health matters to Apex
because performance stands on it. Apex reaches health through the data athletes
already collect, such as Apple Health, without becoming a wellness app. Sleep
scores, meditation and mood tracking earn a place only as inputs to training.

## Articles

### I. The athlete sets the dial.

Apex has a floor and no ceiling. The floor is logging a workout and seeing
progress, and it takes seconds and no setup. Everything above it (goals,
profile context, analytics, recovery, periodization) is there for those who
want it and out of sight for those who don't. No feature may raise the floor.

*Test:* Can a new athlete log a workout and see a PR without touching profile,
goals or analytics?

### II. Every action is one reach away.

When an athlete wants to act, the control is where their hand already is:
create a workout, reorder an exercise, switch a set from reps to time, build a
Murph. Each screen is judged by how few decisions stand between intent and
done. Voice logging is one answer to friction, not the answer.

*Test:* Count the taps, then ask which one could go.

### III. Training varies; Apex bends to it.

A climbing session, an alpine push, a swim, a mountain bike ride and a chipper
each have their own shape. Apex records each in its own shape instead of
forcing it into a lifting log. The data model never assumes one sport.

*Test:* Could a climber, a swimmer and a powerlifter each log last week
truthfully?

### IV. Your kit, your choice.

Athletes choose their watch, strap, ring, power meter and scale; Apex meets
them there. It is where the data arrives, never a walled garden with its own
hardware. Health platforms are the bridge between fitness and health.
Integrations are prioritized by how many athletes they reach. None locks the
athlete in: their data leaves as easily as it arrives.

### V. Trust the athlete.

Apex treats its users as competent and intelligent, the way Costco treats its
members as rational. It explains without condescending, shows the real numbers,
and leaves the athlete's training decisions to the athlete. It never
manipulates: no streak guilt, no manufactured urgency, no engagement tricks, no
sale of data.

*Test:* Would this copy, nudge or default embarrass us if the athlete saw why
we wrote it?

### VI. The numbers are true.

Every number Apex shows is computed in code, deterministically, and tested. The
coach interprets numbers; it never produces them. A bad model can write a bad
sentence. It cannot corrupt a PR.

### VII. Nothing changes without the athlete.

The coach proposes; the athlete decides. No change to a plan, log or record
takes effect without their confirmation.

## When articles conflict

Trust (V, VI, VII) outranks friction and breadth (I–IV). Confirmation is
friction Apex keeps on purpose: Article II removes friction everywhere except
where it protects the athlete's authority over their own training. Breadth
(III, IV) never comes at the floor's expense (I).

## What Apex will not do

- Sell or rent athlete data, or use it for anything but serving that athlete.
- Use engagement mechanics in place of value.
- Act on an athlete's behalf without consent.
- Talk down to the people it serves.
- Make an athlete adopt a feature they didn't ask for in order to use one they
  did.
- Become a wellness app.

## Amending

Only Shane amends this document. Agents may propose an amendment in a PR of its
own and never edit this file as a side effect of other work; the merge policy
holds any change to it for Shane's `shipit` label. A spec that would break an
article stops and names the article.
