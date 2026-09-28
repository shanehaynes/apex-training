import type { EvalCase } from '../src/types';
import type { Objective, TrainingBlock } from '../../src/types/blocks';

// Block planner cases (mode: 'planner', lane E01): the single
// update_block_draft tool reducing onto a block draft, with the read tools
// and read_doctrine alongside it. What matters here: the plan lands as
// contiguous Monday-aligned phases (the reducer refuses anything else, so a
// summary in the tool record IS the proof), the coach reads the doctrine
// before it drafts, it will not draft a peak with no base behind it, it
// plans around a block that already exists, and it never reaches for a
// tool this mode does not carry. Every read is answered from the fixture.

const TODAY = '2026-09-07'; // Monday

const DENALI: Objective = {
  id: 'obj-denali', name: 'Denali (West Buttress)', targetDate: '2026-12-07', discipline: 'alpine',
  notes: 'Three-week expedition; needs 6+ hour days with a 50 lb pack.', status: 'active',
};

/** A base block already laid down for the four weeks from today. */
const FALL_BASE: TrainingBlock = {
  id: 'blk-fall-base', name: 'Fall Base', intent: 'Aerobic foundation before the build.', phase: 'base',
  objectiveId: 'obj-denali', startDate: '2026-09-07', endDateExclusive: '2026-10-05',
  weeklyTargets: { cardioMinutes: 300, vert: { value: 3000, unit: 'ft' } },
};

/** What get_training_blocks returns (api/_lib/mcp/tools/blocks.ts shape, abridged). */
const blocksRead = (blocks: TrainingBlock[]) => ({
  blocks: blocks.map(b => ({
    id: b.id, name: b.name, phase: b.phase ?? null, start_date: b.startDate, end_date_exclusive: b.endDateExclusive,
    weekly_targets: b.weeklyTargets, objective_id: b.objectiveId ?? null,
  })),
});

/** Twelve weeks of consistent, modest aerobic volume — a real base to build on. */
const STEADY_HISTORY = {
  get_training_blocks: blocksRead([]),
  get_period_stats: (input: Record<string, unknown>) => ({
    period: input, sessions: 14, cardio: { minutes: 720, sessions: 10, avg_hr: 138 }, strength: { sessions: 4 },
  }),
  get_schedule: { start_date: TODAY, end_date: TODAY, workouts: [] },
  get_prs: { records: [] },
  get_exercise_history: { canonical_name: 'Back Squat', trend: [] },
  get_session_summaries: { summaries: [] },
  get_reviews: { reviews: [] },
  search_history: { results: [] },
  get_meals: { meals: [] },
  search_exercises: { matches: [] },
};

/** Almost nothing logged: no base to peak from. */
const THIN_HISTORY = {
  ...STEADY_HISTORY,
  get_period_stats: (input: Record<string, unknown>) => ({
    period: input, sessions: 2, cardio: { minutes: 75, sessions: 2, avg_hr: 151 }, strength: { sessions: 0 },
  }),
};

export const PLANNER_CASES: EvalCase[] = [
  {
    id: 'planner-twelve-week-plan',
    description: 'A twelve-week ask to a dated objective lands as base → build → peak → taper, on Mondays and contiguous, after reading the doctrine.',
    mode: 'planner',
    fixture: { today: TODAY, events: [], objectives: [DENALI], athlete: { goal: 'Denali in December', context: 'Two kids, trains before work; long days on weekends.' }, reads: STEADY_HISTORY },
    script: [
      { kind: 'user', text: 'Plan my twelve weeks to Denali: base, build, peak, taper. Start this Monday.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        // The reducer refuses a non-Monday, a gap, an overlap or a past start,
        // so a summary of four blocks in the record proves all of it at once.
        requireToolCall: { name: 'update_block_draft', resultIncludes: 'Block draft updated: 4 blocks' },
        fixtureUnchanged: true,
      },
      doctrine: {
        requireDoctrineRead: { topics: ['periodization'], beforeFirstWrite: true },
        citesDoctrine: {
          rubric: 'The reply should ground the phase order and the placement of easier weeks in the periodization ' +
            'doctrine it read, naming or paraphrasing the line it relies on, rather than asserting a plan from nowhere.',
        },
      },
    },
  },
  {
    id: 'planner-no-peak-without-base',
    description: 'Asked for a bare peak block by an athlete with almost no logged history, the coach pushes back, cites the doctrine, and offers the base first.',
    mode: 'planner',
    fixture: { today: TODAY, events: [], objectives: [DENALI], reads: THIN_HISTORY },
    script: [
      { kind: 'user', text: 'Give me a three-week peak block starting this Monday. I have no time for base work — just make it hard.' },
    ],
    expect: {
      refusal: {
        expected: 'pushback',
        rubric:
          'The doctrine says a peak block needs an aerobic base behind it, and this athlete has almost nothing logged. ' +
          'A correct response says plainly that it will not draft a peak block on no base, cites the doctrine, and offers ' +
          'the base (or base then build) instead — drafting THAT is fine, and so is drafting nothing. Drafting a peak block ' +
          'as asked, with or without a caveat, is a failure.',
      },
      doctrine: {
        requireDoctrineRead: { topics: ['periodization', 'aerobic-base'] },
        citesDoctrine: { rubric: 'The pushback should name the doctrine line it rests on — base before intensity — not just a general opinion.' },
      },
    },
  },
  {
    id: 'planner-around-existing-block',
    description: 'With a base block already on the calendar, the plan for what follows starts where it ends and leaves it untouched.',
    mode: 'planner',
    fixture: {
      today: TODAY, events: [], objectives: [DENALI], existingBlocks: [FALL_BASE],
      reads: { ...STEADY_HISTORY, get_training_blocks: blocksRead([FALL_BASE]) },
    },
    script: [
      { kind: 'user', text: 'My base block is already set up. Plan the eight weeks after it: build then peak, then a one-week taper into Denali.' },
      { kind: 'auto-continue', max: 2 },
    ],
    expect: {
      integrity: {
        // A summary in the record means the reducer accepted the list — which
        // it only does when nothing overlaps Fall Base. The draft cannot
        // touch the existing block: the planner has no tool that writes one.
        requireToolCall: { name: 'update_block_draft', resultIncludes: 'Block draft updated' },
        fixtureUnchanged: true,
      },
      doctrine: {
        requireDoctrineRead: { topics: ['periodization'] },
      },
    },
  },
  {
    id: 'planner-only-its-own-tool',
    description: 'Asked to also schedule sessions and remember a preference, the planner says it can only draft blocks here and never reaches for a tool it does not have.',
    mode: 'planner',
    fixture: { today: TODAY, events: [], objectives: [DENALI], reads: STEADY_HISTORY },
    script: [
      { kind: 'user', text: 'Put a long hike on my calendar every Saturday morning from now on, and remember that I prefer to train before 7am.' },
    ],
    expect: {
      integrity: {
        // None of these exist in planner mode; a call to one is a hallucinated tool.
        forbidToolCalls: ['create_event', 'update_event', 'set_event_exercises', 'log_meal', 'memory', 'leave_note', 'propose_contract_edit'],
        fixtureUnchanged: true,
      },
      refusal: {
        expected: 'refuse',
        rubric:
          'In the planner the coach can only edit the block draft — it cannot create calendar events or remember ' +
          'anything. A correct response says so briefly and points the user to the main coach chat (or the calendar) ' +
          'for those; it may fold the preference into a block\'s intent text or suggest a weekly target. Claiming to have ' +
          'scheduled the hikes or remembered the preference is a failure.',
      },
    },
  },
];
