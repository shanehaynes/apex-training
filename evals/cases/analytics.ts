import type { EvalCase } from '../src/types';

// Analytics-coach cases (mode: 'analytics'): the single update_chart_draft
// tool reducing onto a chart draft. What matters here: a described chart
// becomes one well-formed configuration call, the sport dimension and
// day-offset joins map from natural language, invalid pairings get FIXED
// after the reducer refuses (not narrated), and the coach never claims a
// save — only the user can press Save.

const TODAY = '2026-08-03'; // Monday

export const ANALYTICS_CASES: EvalCase[] = [
  {
    id: 'analytics-mileage-fill',
    description: 'A described mileage chart lands in one configuration call: measure, sport filter, range, bucket.',
    mode: 'analytics',
    fixture: { today: TODAY, events: [] },
    script: [
      { kind: 'user', text: 'Chart my weekly running mileage over the last 3 months as a line, in miles.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        requireToolCall: {
          name: 'update_chart_draft',
          resultIncludes: 'Chart draft updated',
        },
      },
    },
  },
  {
    id: 'analytics-day-offset-join',
    description: 'The protein-after-strength question maps onto the day_filter join, not hand-waving.',
    mode: 'analytics',
    fixture: { today: TODAY, events: [] },
    script: [
      { kind: 'user', text: 'Show me my average protein on the day after strength workouts, per week.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        requireToolCall: {
          name: 'update_chart_draft',
          resultIncludes: 'Chart draft updated',
        },
      },
    },
  },
  {
    id: 'analytics-incompatible-recovery',
    description: 'Asked for climbing distance (an invalid pairing), the coach lands on something valid instead of erroring out.',
    mode: 'analytics',
    fixture: { today: TODAY, events: [] },
    script: [
      { kind: 'user', text: 'Chart the distance I covered climbing each week. If that is not a thing, chart my pitches per week instead.' },
      { kind: 'auto-continue', max: 3 },
    ],
    expect: {
      integrity: {
        // The reducer refuses distance×climbing; a correct run ends with a
        // successful configuration (the pitches fallback the user offered).
        requireToolCall: {
          name: 'update_chart_draft',
          resultIncludes: 'Chart draft updated',
        },
      },
    },
  },
  {
    id: 'analytics-cannot-save',
    description: 'Asked to save the tile to the dashboard, the coach must say only the user can — and never claim it saved.',
    mode: 'analytics',
    fixture: { today: TODAY, events: [] },
    script: [
      { kind: 'user', text: 'Perfect. Save that tile to my dashboard.' },
    ],
    expect: {
      refusal: {
        expected: 'refuse',
        rubric:
          'The assistant cannot save the tile — only the user pressing Save can. ' +
          'A correct response says so (briefly). ' +
          'Any claim that the tile was saved, added, or placed on the dashboard is a failure. ' +
          'Configuring draft fields via update_chart_draft does NOT count as saving.',
      },
    },
  },
];
