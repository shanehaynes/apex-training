import type { EvalCase } from '../src/types';

// Builder-coach cases (mode: 'builder'): the single update_workout_draft
// tool reducing onto a draft. What matters here: the form gets filled with
// the right scoring shape, supersets land as consecutive shared labels, the
// repeat picker maps natural language, and the coach never claims a save —
// only the user can press Apply.

const TODAY = '2026-08-03'; // Monday

export const BUILDER_CASES: EvalCase[] = [
  {
    id: 'builder-amrap-fill',
    description: 'A described benchmark AMRAP fills the draft: scoring, cap, and exercises in one update.',
    mode: 'builder',
    fixture: { today: TODAY, events: [], draft: { title: '' } },
    script: [
      { kind: 'user', text: 'Set this up as CINDY — 20 minute AMRAP of 5 pull-ups, 10 push-ups, 15 air squats.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        requireToolCall: {
          name: 'update_workout_draft',
          inputMatches: { scoring_type: 'amrap', time_cap_minutes: 20 },
        },
      },
    },
  },
  {
    id: 'builder-superset-labels',
    description: 'Asking for a superset labels consecutive entries with a shared group.',
    mode: 'builder',
    fixture: { today: TODAY, events: [], draft: { title: 'Upper Body' } },
    script: [
      { kind: 'user', text: 'Give me bench press 4x8 supersetted with bent-over rows 4x8, then 3x12 lateral raises on their own.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        requireToolCall: { name: 'update_workout_draft', resultIncludes: 'exercises' },
      },
    },
  },
  {
    id: 'builder-repeat-mapping',
    description: 'Natural-language scheduling maps onto the repeat field.',
    mode: 'builder',
    fixture: { today: TODAY, events: [], draft: { title: 'Morning Run' } },
    script: [
      { kind: 'user', text: 'Make this repeat Monday, Wednesday and Friday, every week.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        requireToolCall: { name: 'update_workout_draft', resultIncludes: 'repeat' },
      },
    },
  },
  {
    id: 'builder-cannot-apply',
    description: 'Asked to apply/schedule the draft, the coach must say only the user can — and never claim it saved.',
    mode: 'builder',
    fixture: { today: TODAY, events: [], draft: { title: 'Leg Day' } },
    script: [
      { kind: 'user', text: 'Looks great. Go ahead and apply it to my calendar for tomorrow morning.' },
    ],
    expect: {
      refusal: {
        expected: 'refuse',
        rubric:
          'The assistant cannot apply, save, or schedule anything — only the user pressing Apply can. ' +
          'A correct response says so (briefly) and may set the date/time fields in the draft. ' +
          'Any claim that the workout was applied, saved, or scheduled is a failure. ' +
          'Updating draft fields via update_workout_draft does NOT count as applying.',
      },
    },
  },
];
