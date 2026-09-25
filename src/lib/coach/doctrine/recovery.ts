import type { DoctrineTopic } from './types.js';

export const RECOVERY: DoctrineTopic = {
  id: 'recovery',
  title: 'Recovery, monitoring and load management',
  summary:
    'Adaptation happens in recovery: protect sleep and fueling, read resting heart rate, HRV trend, aerobic decoupling and the acute-to-chronic load ratio as the app sees them, deload on schedule, separate soreness from injury by the safety rules, and treat consistency as the goal.',
  text: `Training is the stimulus; recovery is where the body turns it into fitness. The coach manages recovery as deliberately as it manages load, because an athlete who trains well and recovers badly is an athlete getting slower.

## Sleep and fueling

Sleep is the primary recovery tool and nothing substitutes for it. Most of the hormonal and tissue repair that follows a hard session happens during sleep, and a short night after a hard day means the day's adaptation is partly lost. The guideline for a training athlete is roughly seven to nine hours a night, more during high-volume weeks, with consistency of timing mattering nearly as much as duration. When sleep is short for several nights, the coach reduces load before the body forces the reduction.

Fueling is the second tool. A mountain athlete in a base phase burns a large amount of energy on easy work, and under-eating then is the most common reason a base phase produces fatigue instead of fitness. The rules: eat enough to support the training, eat carbohydrate around harder sessions and long days, eat protein regularly through the day, and never use training to erase food. The app's nutrition logging shows whether intake is keeping pace with load; it is not a tool for restriction. Any signal of restriction, purging or training to compensate for eating is a red flag the safety rules already handle: the coach declines the programming request and refers.

## The signals the app can see

The app records several signals, and each carries a specific meaning. The coach reads trends, not single readings, because every one of these is noisy day to day.

1. Resting heart rate. A morning resting heart rate that trends upward over several days, by several beats above the athlete's usual, indicates incomplete recovery, oncoming illness or accumulated stress. A single high reading is noise. A rising week is a signal to reduce load.

2. HRV trend. Heart-rate variability reflects the balance of the autonomic nervous system. A downward trend over a week or more, relative to the athlete's own baseline, points to fatigue, stress or illness. An upward or stable trend during a building block is reassurance. The absolute number means little; the direction relative to the athlete's own baseline is what counts.

3. Heart-rate drift on steady efforts, also called aerobic decoupling. On a long effort at constant pace, the degree to which heart rate rises in the second half relative to the first is a direct measure of aerobic fitness at that intensity. Low drift, under roughly three to five percent, means the effort was aerobically well supported. High drift on an effort that used to show low drift, at the same pace, means the athlete is fatigued, dehydrated, under-fueled or getting ill. Tracked over weeks, falling drift at a given pace is the clearest evidence in the app that the base is building.

4. The acute-to-chronic load ratio. The ratio of the last week's training load to the average of the last several weeks describes how sharply load has risen. A ratio near one means load is steady. A ratio well above one, with roughly one and a half as the common warning line, means the last week was a spike relative to what the body is used to, and injury risk rises with spikes regardless of the absolute load. A ratio well below one for weeks means fitness is being lost. The ratio matters because tissue adapts to what it has been doing, not to what the athlete intends; a big week after several small ones is where injuries happen.

None of these signals decides anything alone. Two of them moving the same way, or one of them moving alongside what the athlete reports about sleep, mood and soreness, is a pattern the coach acts on.

## Planned deloads

A deload is a reduced-load week placed before fatigue demands it. The common guideline is one every third or fourth week, with volume cut by roughly a third to a half and intensity kept light. The deload is where the previous weeks' training consolidates into fitness; skipping it does not save time, it delays the adaptation and raises the chance of the unplanned deload that illness or injury imposes.

Signs a deload should come early: rising resting heart rate, falling HRV trend, rising drift on easy efforts, poor sleep, flat mood, a lift that fails at a previously clean load. Two or more of these together, and the coach brings the deload forward rather than finishing the block.

## Overreaching and overtraining

Overreaching is short-term fatigue from a hard block, cleared by a deload of a week or two, and it is a normal part of training. Overtraining is a longer-term state produced by months of load exceeding recovery, with persistent fatigue, falling performance, disturbed sleep, mood changes and often frequent illness, and it takes weeks to months of reduced training to reverse. The line between them is whether the deload works. If a reduced week restores freshness, the athlete was overreached. If it does not, the coach treats the situation as possible overtraining, reduces load substantially, and recommends the athlete see a clinician to rule out the medical causes that mimic it.

## Soreness versus injury

The app's safety rules draw this line and the doctrine restates it the same way.

Soreness is a training input. Delayed-onset muscle soreness after a new or hard session, general fatigue, and the ordinary ache of a big day are normal, they resolve in a few days, and they inform the next session's load without stopping it. A cleared old injury is also a training input.

Reported pain is not. Acute pain, swelling, numbness, a sharp or localized pain that changes movement, or a named injury stops loading the affected region, and the coach says so once and plainly, then points the athlete to a clinician. The coach does not diagnose, does not interpret symptoms, does not prescribe rehabilitation, and does not program around a reported injury as if it were a preference. Training of unaffected regions can continue only within whatever a clinician has cleared. Medical restrictions recorded in the athlete's profile are constraints that only the clinician who set them can lift.

The distinction the coach uses: soreness is diffuse, symmetrical, arrives a day or two after the work and fades; injury is local, often one-sided, arrives during or right after a movement, and does not fade with easy movement. When the athlete's description is unclear, the coach asks, and if it remains unclear, it treats the report as pain.

## Illness

A common and workable guideline: symptoms above the neck only, such as a mild cold with a runny nose or a scratchy throat, allow easy training at reduced volume if the athlete feels up to it. Symptoms below the neck, meaning fever, body aches, chest congestion, a productive cough or gut symptoms, mean rest until they have fully cleared and for a day or two after. Training through a fever is dangerous and delays recovery. The return after illness follows the missed-weeks rule: resume at the load before the gap, not the planned load.

## Consistency beats heroics

The athlete who trains moderately every week for a year is fitter than the athlete who trains heroically for a month and then breaks. Every rule in this topic serves that. A recovery week is not a lost week. A short session done is worth more than a long session skipped. A day off taken when the signals say so protects the month. The coach's job is to keep the athlete training next month, not to extract the most from this week.

## How the coach applies this

- Reduce load when the athlete reports several consecutive short nights, and treat sleep as a training variable rather than a personal matter.
- Check that fueling is keeping pace with load during high-volume phases, and decline and refer on any signal of restriction, purging or training to erase food.
- Read resting heart rate, HRV, drift and the acute-to-chronic ratio as trends against the athlete's own baseline, and act when two signals move together or one moves alongside what the athlete reports.
- Keep the acute-to-chronic load ratio from spiking, with roughly one and a half as the warning line, by raising load gradually and never doubling up after a missed week.
- Program a deload every third or fourth week as a guideline and bring it forward when two or more fatigue signals appear together.
- Treat a deload that does not restore freshness as possible overtraining, reduce load substantially, and recommend a clinician visit.
- Keep coaching through soreness, ordinary fatigue and a cleared old injury, and stop loading a region on any reported pain, swelling, numbness or named injury while pointing to a clinician.
- Allow easy reduced training with above-the-neck symptoms only, require rest with below-the-neck symptoms until fully cleared, and resume at the pre-illness load.
- Prefer the smaller session done to the larger session skipped, in every phase.

## Signals that contradict this

- A resting heart rate several beats above the athlete's usual for three or more consecutive mornings indicates the current load is not being absorbed, and the plan should reduce before the body forces it.
- A downward HRV trend over a week or more, relative to the athlete's own baseline, is a fatigue or illness signal even when the athlete reports feeling fine.
- Heart-rate drift that rises on an effort at a pace and duration that recently showed low drift indicates fatigue, under-fueling, dehydration or illness rather than a need for more training.
- An acute-to-chronic load ratio well above one after a week of unusually high volume marks a spike that raises injury risk, and the following week should hold or drop regardless of how good the athlete feels.
- A reduced week that does not restore freshness, performance and mood indicates the fatigue is deeper than overreaching, and the coach should not resume the block.
- Any description of pain that is local, one-sided, sharp, or that arrived during a specific movement is treated as injury rather than soreness, and the coach stops loading that region.
- A logged fever, body aches or chest symptoms mean rest, and no schedule pressure changes that.`,
};
