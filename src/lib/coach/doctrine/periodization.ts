import type { DoctrineTopic } from './types.js';

export const PERIODIZATION: DoctrineTopic = {
  id: 'periodization',
  title: 'Periodization toward an objective',
  summary:
    'A plan runs from transition through base, specific, taper and recovery in that order, with block lengths and weekly templates set by the objective, and missed weeks handled by extending the plan rather than cramming.',
  text: `A training plan is a sequence of phases, each building the capacity the next one needs, ending at a date on which the athlete must be at their best. The sequence is fixed; the lengths, the weekly shape and the specific work are set by the objective.

## The arc

Every cycle moves through the same five phases in the same order. The order comes from the capacity hierarchy: general before specific, base before intensity, load before rest.

1. Transition. Purpose: re-establish the habit of training, restore movement quality, and prepare tissue for the loads to come. Content: low aerobic volume, all easy; general strength with an emphasis on movement quality, unilateral work, carries, core and posterior chain; daily mobility. This phase is short and unglamorous and skipping it is the most common source of early injury.

2. Base. Purpose: build the aerobic foundation and raise max strength. Content: aerobic volume grows week over week, nearly all below the aerobic threshold; the long session grows first; max strength is trained heavy, low-rep, twice a week; mobility is maintained. This is the longest phase and the one that most determines the outcome.

3. Specific. Purpose: convert the general capacities into the objective's actual demand. Content: aerobic volume holds or drops slightly while the long session becomes a rehearsal of the objective, on similar terrain with similar load and duration; max strength converts to muscular endurance through weighted uphill work; intensity that mimics the objective enters, one session per week at first; for a rock objective, climbing-specific strength and power take priority. The specific phase is where the plan starts to look like the objective.

4. Taper and peak. Purpose: shed fatigue while keeping fitness, so the athlete arrives fresh and sharp. Content: volume drops by roughly a third to a half as a guideline, while a small amount of intensity and specificity is kept so the body stays primed. Nothing new is introduced. The athlete will feel restless and under-trained; this is the taper working.

5. Recovery. Purpose: let the body and mind reset before the next cycle. Content: one to several weeks of unstructured, easy, enjoyable movement with no plan. Then the next transition begins.

## How objective type shapes the phases

The arc is the same, but the weight of each phase changes with what the objective demands.

Alpine climb or long mountain day. The aerobic base dominates and base is the longest phase. The specific phase rehearses long uphill efforts under a pack with the objective's vertical; muscular endurance is the key conversion; climbing-specific work is maintained, not built, unless the technical crux is near the athlete's limit.

Ski traverse or multi-day ski objective. As above, with the specific phase built on skinning under load and long consecutive days. Skiing itself is the best specific work once snow allows.

Rock project or technical climbing goal. The aerobic base is maintained rather than grown; climbing-specific strength and power take the place of muscular endurance in the specific phase; the base phase still builds max strength and finger strength because those are the slow adaptations. The result is a climbing plan with an aerobic floor under it, not an aerobic plan with climbing on top.

Hunting season. A long specific phase of loaded uphill hiking and carrying, with muscular endurance as the priority and general strength kept for the pack-out. The objective is repeated big days over weeks, so durability and recovery capacity outrank speed.

With several objectives in a year, the coach chooses one as the primary peak and treats the others as training events or as secondary peaks with a short taper. Two full peaks close together are not possible; the athlete picks.

## Block lengths and the loading pattern

Lengths are guidelines and depend on the athlete's training history and the time available. The proportions matter more than the numbers.

- Transition: roughly four to eight weeks. Shorter for an athlete coming off a consistent season, longer after a layoff or injury.
- Base: roughly eight to sixteen weeks or more. The longer the objective and the wider the aerobic deficiency, the longer the base. An athlete with an aerobic deficiency stays in base until the gap closes.
- Specific: roughly four to eight weeks. Long enough to convert strength to muscular endurance and rehearse the objective several times; short enough that specific fatigue does not accumulate into the taper.
- Taper: roughly one to three weeks, longer for a longer objective and a larger preceding volume.
- Recovery: one to several weeks.

Within a block, the loading pattern is a rise followed by a drop. The common patterns are three building weeks then one reduced week, or two then one for an athlete who recovers slowly or has high life stress. The building weeks raise volume gradually; the reduced week cuts volume by roughly a third to a half and keeps intensity light. The reduced week is not optional and not a reward; it is where the previous three weeks are consolidated into fitness.

A block ends with a check: has the capacity it was meant to build actually moved? Aerobic threshold pace, a strength benchmark, a rehearsal effort on terrain. If it has, the next block begins. If it has not, the coach looks for the reason before moving on.

## What a week looks like in each phase

The templates below are shapes, not schedules. The athlete's life, the pursuits and the weather set the days.

Transition week:
- Two general strength sessions, movement quality first, moderate load.
- Three to four easy aerobic sessions, short, one of them slightly longer.
- Daily mobility minimum.
- One full rest day, and any pursuit outing counts as the long aerobic session.

Base week:
- Two max strength sessions, heavy and brief, on days that do not precede the long session.
- One long easy aerobic session, growing week over week, on terrain and ideally under a light pack.
- Two to four shorter easy aerobic sessions.
- Mobility maintained daily.
- One full rest day.

Specific week:
- One muscular endurance session (weighted uphill work, loaded step-ups or hill repeats), which replaces one max strength session.
- One max strength maintenance session, or a climbing-specific strength session for a rock objective.
- One long session rehearsing the objective's demand.
- One session of objective-specific intensity, once the base has earned it.
- One to two short easy aerobic sessions for recovery and volume.
- One full rest day, sometimes two.

Taper week:
- Volume cut substantially, sessions shorter, the long session shortened most.
- One short session with a little intensity to stay sharp.
- Strength reduced to a light maintenance dose or dropped in the final week.
- Extra sleep, extra rest days.

## When weeks are missed

Life, illness and weather will remove weeks from any plan. The rule is: do not cram, extend.

1. One missed session is absorbed. The plan continues as written.
2. Up to a week missed for illness or life: resume at the load of the week before the gap, not the week that was planned, then progress from there. The objective date does not move, but the block may end a week later and the next block starts a week shorter.
3. Two or more weeks missed: treat the return as a short transition. Resume at reduced volume, rebuild over one to two weeks, then continue the block. If the objective date is fixed, shorten the specific phase rather than the base; if the gap fell in base, the coach and athlete discuss whether the objective is still realistic.
4. Never compress the missed volume into the following weeks. Doubling up violates gradualness and usually produces the injury that removes the next four weeks too.
5. A missed reduced week is missed recovery, not missed volume, and it must be taken before the next building block starts.

The athlete's calendar in the app is the record. When the coach sees a gap, it asks what happened before changing anything, because illness, injury and a busy week each call for a different return.

## How the coach applies this

- Anchor every plan on a named objective with a date, and work backward through taper, specific, base and transition to set the block lengths.
- Set the weight of each phase by the objective type, with the aerobic base dominant for alpine, ski and hunting objectives and climbing-specific work taking the specific phase for a rock objective.
- Keep an athlete with an aerobic deficiency in base until the threshold gap closes, and shorten the specific phase rather than the base if the date is fixed.
- Program each block as building weeks followed by one reduced week, using three-then-one as the default and two-then-one when recovery signals or life stress warrant it.
- End each block with a concrete check of the capacity it was meant to build, and do not begin the next block until the check has been read.
- Build a weekly template that names the long session, the strength sessions and the rest day first, then fills the remaining days with easy volume.
- Introduce nothing new in the taper, and cut volume by roughly a third to a half while keeping a small dose of intensity.
- When weeks are missed, resume at the load before the gap and extend the block, and never compress the missed volume into the following weeks.
- Ask what caused a gap in the calendar before changing the plan, because illness, injury and a busy week call for different returns.

## Signals that contradict this

- A benchmark that has not moved at the end of a block, with good recovery signals and high completion, indicates the block's stimulus was too small and the next block should raise load rather than simply continue.
- A benchmark that has not moved with poor recovery signals indicates the block was not absorbed, and the next block should begin with an extended reduced period rather than more load.
- An athlete who arrives at the specific phase with a wide threshold gap has left base too early, and the coach should extend base and shorten the specific phase even if the plan said otherwise.
- Rising fatigue, worsening sleep or falling motivation during a taper indicates the taper has cut too little or too late, and the remaining volume should drop further.
- A pursuit calendar that already contains long outings most weekends means the plan's long session is being provided by the pursuits, and the coach should count those outings rather than add a second long session.
- Two objectives placed within a few weeks of each other cannot both receive a full peak, and the coach should ask the athlete which one is primary before building either plan.`,
};
