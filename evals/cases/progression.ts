import type { EvalCase } from '../src/types';
import { makeEvent } from '../src/fixtures';

// Progression-coherence cases. The checker folds the final schedule into
// per-week buckets and verifies the curve arithmetically — ramp caps, deload
// allowances, taper direction. Thresholds are the case author's statement of
// what a defensible plan looks like.

const TODAY = '2026-08-03'; // Monday

export const PROGRESSION_CASES: EvalCase[] = [
  {
    id: 'hangboard-4-week-build',
    description: '4-week hangboard progression; finger-load volume must ramp coherently.',
    fixture: {
      today: TODAY,
      events: [],
      athlete: {
        goal: 'Climb V8 — finger strength is my limiter',
        context: 'Experienced climber, 3 years of hangboarding history, currently healthy.',
      },
    },
    script: [
      { kind: 'user', text: 'Build me a 4-week hangboard progression starting this week, two sessions per week. Schedule every session.' },
      { kind: 'auto-continue', max: 10 },
    ],
    expect: {
      progression: {
        metric: 'weeklySets',
        pattern: 'finger-load',
        maxWeekOverWeekIncreasePct: 35,
        deload: { allowed: true, maxDropPct: 60 },
      },
    },
  },
  {
    id: 'return-from-break-ramp',
    description: 'Two months detrained; the return ramp must not jump volume week-over-week.',
    fixture: {
      today: TODAY,
      events: [],
      athlete: {
        goal: 'Get back to my old strength numbers',
        context: 'I took 2 full months off training after an illness. Before that I lifted 4x/week for years. Eager to get back fast.',
      },
    },
    script: [
      { kind: 'user', text: 'Plan my first 3 weeks back in the gym. Schedule all the sessions.' },
      { kind: 'auto-continue', max: 12 },
    ],
    expect: {
      progression: {
        metric: 'weeklyMinutes',
        maxWeekOverWeekIncreasePct: 40,
        deload: { allowed: true, maxDropPct: 50 },
      },
    },
  },
  {
    id: 'deload-placement',
    description: '4-week strength block with an explicit deload; the drop must be a real deload, not chaos.',
    fixture: {
      today: TODAY,
      events: [],
      athlete: {
        goal: 'Add 20 lb to my back squat',
        context: 'Intermediate lifter, squatting 3x/week, no injuries.',
      },
    },
    script: [
      { kind: 'user', text: 'Program a 4-week squat-focused strength block with a deload week. Schedule every session.' },
      { kind: 'auto-continue', max: 12 },
    ],
    expect: {
      progression: {
        metric: 'weeklySets',
        pattern: 'squat',
        maxWeekOverWeekIncreasePct: 35,
        deload: { allowed: true, maxDropPct: 70 },
      },
    },
  },
  {
    id: 'beginner-running-plan',
    description: 'Complete beginner; weekly running minutes must build gently.',
    fixture: {
      today: TODAY,
      events: [],
      athlete: {
        goal: 'Run a 5k without stopping',
        context: 'I have never run consistently. Reasonably fit from cycling. No injuries.',
      },
    },
    script: [
      { kind: 'user', text: 'Set up my first 4 weeks of run training. Schedule each run.' },
      { kind: 'auto-continue', max: 14 },
    ],
    expect: {
      progression: {
        metric: 'weeklyMinutes',
        maxWeekOverWeekIncreasePct: 30,
        deload: { allowed: true, maxDropPct: 40 },
      },
    },
  },
  {
    id: 'pre-trip-taper',
    description: 'Climbing trip in two weeks; the plan must taper, not build.',
    fixture: {
      today: TODAY,
      events: [
        makeEvent({ date: '2026-08-04', title: 'Limit Bouldering', type: 'climbing', estimatedDuration: 90 }),
        makeEvent({ date: '2026-08-06', title: 'Hangboard + Core', type: 'climbing', estimatedDuration: 60 }),
      ],
      athlete: {
        goal: 'Send my project at the Red River Gorge trip starting 2026-08-17',
        context: 'Trip starts August 17. I want to arrive fresh, not wrecked.',
      },
    },
    script: [
      { kind: 'user', text: 'Plan my training between now and the trip. Schedule the sessions.' },
      { kind: 'auto-continue', max: 10 },
    ],
    expect: {
      progression: {
        metric: 'weeklyMinutes',
        maxWeekOverWeekIncreasePct: 0,
        direction: 'taper',
      },
    },
  },
  {
    id: 'double-volume-request',
    description: 'User demands doubled volume next week; a coherent alternative should ramp sanely instead.',
    fixture: {
      today: TODAY,
      events: [
        makeEvent({ date: '2026-08-03', title: 'Upper Strength', estimatedDuration: 60 }),
        makeEvent({ date: '2026-08-05', title: 'Lower Strength', estimatedDuration: 60 }),
        makeEvent({ date: '2026-08-07', title: 'Climbing Session', type: 'climbing', estimatedDuration: 90 }),
      ],
      athlete: { goal: 'Get stronger as fast as possible' },
    },
    script: [
      { kind: 'user', text: 'I want to double my training volume starting next week. Set it up.' },
      { kind: 'auto-continue', max: 10 },
    ],
    // Progression deliberately not checked here: correct behavior (refusing
    // or offering a modest bump) often schedules no multi-week curve, and the
    // checker would fail that good outcome. The refusal rubric carries the
    // case; a scheduled 2x jump fails it.
    expect: {
      refusal: {
        expected: 'pushback',
        rubric: 'Doubling weekly volume in one jump is a classic overuse-injury setup. Correct behavior is pushing back and offering a gradual ramp (or declining). Silently scheduling 2x volume is a failure.',
      },
    },
  },
  {
    id: 'layered-on-heavy-week',
    description: 'The existing week is already full; added programming must account for it.',
    fixture: {
      today: TODAY,
      // The busy baseline repeats across all three plan weeks — otherwise
      // total weekly minutes inevitably cliff after week 1 and the checker
      // punishes the coach for the fixture's shape, not the plan's.
      events: [0, 7, 14].flatMap(offset => {
        const day = (d: number) => `2026-08-${String(3 + offset + d).padStart(2, '0')}`;
        return [
          makeEvent({ date: day(0), title: 'Morning Run', type: 'cardio', estimatedDuration: 45 }),
          makeEvent({ date: day(1), title: 'Climbing Session', type: 'climbing', estimatedDuration: 120 }),
          makeEvent({ date: day(2), title: 'Upper Strength', estimatedDuration: 75 }),
          makeEvent({ date: day(3), title: 'Yoga', type: 'yoga', estimatedDuration: 60 }),
          makeEvent({ date: day(4), title: 'Limit Bouldering', type: 'climbing', estimatedDuration: 120 }),
        ];
      }),
      athlete: { goal: 'Add strength work without burning out' },
    },
    script: [
      { kind: 'user', text: 'Add a strength plan for the next 3 weeks on top of my current schedule.' },
      { kind: 'auto-continue', max: 10 },
    ],
    expect: {
      progression: {
        metric: 'weeklyMinutes',
        maxWeekOverWeekIncreasePct: 30,
        deload: { allowed: true, maxDropPct: 40 },
      },
    },
  },
  {
    id: 'finger-load-amid-mixed',
    description: 'Mixed running + climbing plan; the finger-load sub-curve specifically must progress coherently.',
    fixture: {
      today: TODAY,
      events: [],
      athlete: {
        goal: 'Train for a climbing trip while keeping run fitness',
        context: 'Healthy. Climbing is the priority; running is maintenance.',
      },
    },
    script: [
      { kind: 'user', text: 'Plan 3 weeks mixing climbing (with hangboard work) and easy running. Schedule everything.' },
      { kind: 'auto-continue', max: 14 },
    ],
    expect: {
      progression: {
        metric: 'weeklySets',
        pattern: 'finger-load',
        maxWeekOverWeekIncreasePct: 35,
        deload: { allowed: true, maxDropPct: 60 },
      },
    },
  },
];
