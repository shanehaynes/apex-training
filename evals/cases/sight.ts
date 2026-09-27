import type { EvalCase } from '../src/types';
import { makeEvent, makePhysiology } from '../src/fixtures';
import type { WorkoutEvent } from '../../src/types/workout';

// Sight cases: the coach has read tools and a physiology panel now, and the
// prompt tells it to read before it prescribes and cite what it read. These
// cases check, deterministically, that a data question is answered by
// LOOKING — the right read ran — and that a turn of reads leaves the
// fixture exactly as it found it. Every read is answered from the fixture
// (fixture.reads), so the cases cost one or two model calls each.

const TODAY = '2026-08-03'; // Monday

const WRITE_TOOLS = [
  'create_event', 'update_event', 'delete_event', 'set_event_exercises',
  'update_exercise_definition', 'log_meal', 'update_meal', 'delete_meal',
];

/** get_schedule's row shape (api/_lib/mcp/tools/schedule.ts), from fixture events. */
function scheduleRows(events: WorkoutEvent[], input: Record<string, unknown>) {
  const start = String(input.start_date ?? '0000-00-00');
  const end = String(input.end_date ?? '9999-99-99');
  return {
    start_date: start,
    end_date: end,
    workouts: events
      .filter(e => e.date >= start && e.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(e => ({
        date: e.date, event_id: e.id, title: e.title, type: e.type,
        start_time: e.startTime ?? null, end_time: e.endTime ?? null,
        duration_min: e.estimatedDuration, location: e.location ?? null,
        completed: e.isCompleted,
      })),
  };
}

// Four completed weeks of hand-logged Z2 running that fall off in the last
// two: the physiology panel shows the drop, the reads explain it.
const Z2_SESSIONS = [
  // W-4 (Jul 6–12): 180 min
  { date: '2026-07-07', minutes: 60, avgHr: 140 },
  { date: '2026-07-09', minutes: 60, avgHr: 141 },
  { date: '2026-07-11', minutes: 60, avgHr: 139 },
  // W-3 (Jul 13–19): 210 min
  { date: '2026-07-14', minutes: 60, avgHr: 141 },
  { date: '2026-07-16', minutes: 60, avgHr: 140 },
  { date: '2026-07-18', minutes: 90, avgHr: 138 },
  // W-2 (Jul 20–26): 90 min — long run cut short, one skipped
  { date: '2026-07-21', minutes: 60, avgHr: 142 },
  { date: '2026-07-25', minutes: 30, avgHr: 142 },
  // W-1 (Jul 27–Aug 2): 45 min — travel week
  { date: '2026-07-29', minutes: 45, avgHr: 141 },
];

const Z2_EVENTS: WorkoutEvent[] = [
  makeEvent({ id: 'evt-run-0721', date: '2026-07-21', title: 'Easy Run', type: 'cardio', estimatedDuration: 60, isCompleted: true }),
  makeEvent({ id: 'evt-long-0725', date: '2026-07-25', title: 'Long Run', type: 'cardio', estimatedDuration: 120, isCompleted: true }),
  makeEvent({ id: 'evt-run-0729', date: '2026-07-29', title: 'Easy Run', type: 'cardio', estimatedDuration: 45, isCompleted: true }),
  makeEvent({ id: 'evt-long-0801', date: '2026-08-01', title: 'Long Run', type: 'cardio', estimatedDuration: 120, isCompleted: false }),
  makeEvent({ id: 'evt-run-0804', date: '2026-08-04', title: 'Easy Run', type: 'cardio', estimatedDuration: 60 }),
  makeEvent({ id: 'evt-long-0808', date: '2026-08-08', title: 'Long Run', type: 'cardio', estimatedDuration: 120 }),
];

const LAST_WEEK_EVENTS: WorkoutEvent[] = [
  makeEvent({ id: 'evt-lw-mon', date: '2026-07-27', title: 'Max Strength A', estimatedDuration: 60, isCompleted: true }),
  makeEvent({ id: 'evt-lw-tue', date: '2026-07-28', title: 'Easy Run', type: 'cardio', estimatedDuration: 60, isCompleted: true }),
  makeEvent({ id: 'evt-lw-wed', date: '2026-07-29', title: 'Hill Hike', type: 'cardio', estimatedDuration: 90, isCompleted: false }),
  makeEvent({ id: 'evt-lw-thu', date: '2026-07-30', title: 'Max Strength B', estimatedDuration: 60, isCompleted: true }),
  makeEvent({ id: 'evt-lw-sat', date: '2026-08-01', title: 'Long Hike', type: 'cardio', estimatedDuration: 240, isCompleted: true }),
  makeEvent({ id: 'evt-tw-mon', date: '2026-08-03', title: 'Max Strength A', estimatedDuration: 60 }),
  makeEvent({ id: 'evt-tw-tue', date: '2026-08-04', title: 'Easy Run', type: 'cardio', estimatedDuration: 60 }),
  makeEvent({ id: 'evt-tw-sat', date: '2026-08-08', title: 'Long Hike', type: 'cardio', estimatedDuration: 270 }),
];

export const SIGHT_CASES: EvalCase[] = [
  {
    id: 'sight-z2-volume-drop',
    description: 'A why-question about this month\'s Z2 volume must be answered by reading the record, not by guessing from the panel.',
    fixture: {
      today: TODAY,
      events: Z2_EVENTS,
      athlete: {
        goal: 'Denali, West Buttress, June 2027 — aerobic base first',
        context: 'I log my runs by hand with average heart rate. Threshold HR is about 160.',
      },
      block: {
        name: 'Base 1', intent: 'Aerobic base: grow the long run, everything below AeT.', phase: 'base',
        weekLabel: 'week 5 of 12', rangeLabel: 'Jul 6 – Sep 27',
        objective: { name: 'Denali, West Buttress', targetDate: '2027-06-10' },
        currentWeek: [], toDate: ['cardio 525/960 min (55%)'],
      },
      physiology: makePhysiology(TODAY, Z2_SESSIONS),
      reads: {
        get_period_stats: (input) => ({
          period: { type: input.period_type ?? 'month', year: input.year ?? 2026, month: input.month ?? 8 },
          sessions: { total: 5, completed: 4, by_type: { cardio: 4, weights: 1 } },
          active_days: 4,
          cardio: { minutes: 195, sessions: 4, distance: { mi: 18.2 } },
          notes: 'Two planned long runs in the period were not completed.',
        }),
        get_session_summaries: () => ({
          start: '2026-07-04', end: TODAY,
          sessions: [
            { date: '2026-07-29', title: 'Easy Run', duration_min: 45, summary: '45 easy minutes in the hotel gym on the treadmill; travel week, kept it short.' },
            { date: '2026-07-25', title: 'Long Run', duration_min: 30, summary: 'Cut short at 30 min — head cold, HR drifting high for the pace. Stopped rather than push.' },
            { date: '2026-07-21', title: 'Easy Run', duration_min: 60, summary: 'Steady Z2, 60 min, felt normal.' },
            { date: '2026-07-18', title: 'Long Run', duration_min: 90, summary: '90 min easy on the ridge trail, HR held 140 average. Best long run of the block.' },
          ],
        }),
        get_schedule: (input) => scheduleRows(Z2_EVENTS, input),
      },
    },
    script: [
      { kind: 'user', text: 'Why is my Z2 volume down this month?' },
    ],
    expect: {
      integrity: {
        requireToolCall: { name: ['get_period_stats', 'get_exercise_history', 'get_session_summaries', 'get_schedule'] },
        forbidToolCalls: ['create_event', 'update_event', 'delete_event', 'set_event_exercises'],
      },
    },
  },
  {
    id: 'sight-deadlift-trend',
    description: 'A trend question about one lift must go through get_exercise_history, whose numbers are the only ones the coach may cite.',
    fixture: {
      today: TODAY,
      events: [
        makeEvent({ id: 'evt-str-a', date: '2026-08-04', title: 'Max Strength A', estimatedDuration: 60 }),
      ],
      athlete: {
        goal: 'Rainier via the DC, June 2027',
        context: 'Base block. Deadlift is my main posterior-chain lift; I log every set.',
      },
      reads: {
        search_exercises: () => ({
          matches: [{ canonical_name: 'Deadlift', aliases: ['Conventional Deadlift', 'DL'], category: 'strength', last_performed: '2026-07-30' }],
        }),
        get_exercise_history: (input) => {
          const name = String(input.exercise_name ?? '');
          if (!/dead ?lift|\bdl\b/i.test(name)) {
            throw new Error(`No logged history for "${name}". Use search_exercises to find the right name.`);
          }
          return {
            canonical_name: 'Deadlift',
            resolved_from: name === 'Deadlift' ? undefined : name,
            stat_kind: 'oneRM',
            stat_unit: 'estimated 1RM (lb)',
            all_time_best: { date: '2026-07-30', value: 356, weight: '315 lb', reps: '4' },
            total_sessions: 9,
            trend: [
              { date: '2026-06-04', value: 318 }, { date: '2026-06-18', value: 326 },
              { date: '2026-07-02', value: 334 }, { date: '2026-07-16', value: 345 },
              { date: '2026-07-30', value: 356 },
            ],
            recent_sessions: [
              { date: '2026-07-30', sets: ['315 lb × 4', '315 lb × 4', '315 lb × 3'] },
              { date: '2026-07-16', sets: ['305 lb × 4', '305 lb × 4', '305 lb × 4'] },
              { date: '2026-07-02', sets: ['295 lb × 5', '295 lb × 4', '295 lb × 4'] },
            ],
          };
        },
      },
    },
    script: [
      { kind: 'user', text: 'How\'s my deadlift trending?' },
    ],
    expect: {
      integrity: {
        requireToolCall: { name: 'get_exercise_history' },
        forbidToolCalls: WRITE_TOOLS,
      },
    },
  },
  {
    id: 'sight-reads-never-mutate',
    description: 'A review of last week against the plan runs on reads alone; the fixture must be byte-identical afterwards.',
    fixture: {
      today: TODAY,
      events: LAST_WEEK_EVENTS,
      athlete: {
        goal: 'Grand Teton, Owen-Spalding, August 2027',
        context: 'Base block, two max strength sessions and one long hike a week.',
      },
      block: {
        name: 'Base 1', intent: 'Aerobic base with heavy, brief max strength twice a week.', phase: 'base',
        weekLabel: 'week 4 of 12', rangeLabel: 'Jul 13 – Oct 4',
        objective: { name: 'Grand Teton, Owen-Spalding', targetDate: '2027-08-14' },
        currentWeek: ['cardio 0/480 min (0%)'], toDate: ['cardio 900/1,440 min (63%)', 'strength sessions 6/6 (100%)'],
      },
      reads: {
        get_schedule: (input) => scheduleRows(LAST_WEEK_EVENTS, input),
        get_session_summaries: () => ({
          start: '2026-07-04', end: TODAY,
          sessions: [
            { date: '2026-08-01', title: 'Long Hike', duration_min: 240, summary: '4 h with a 20 lb pack, 3,100 ft of gain. HR average 139. Legs fine, feet sore.' },
            { date: '2026-07-30', title: 'Max Strength B', duration_min: 55, summary: 'Deadlift 315×4×3, step-ups, carries. Clean sets, no grinders.' },
            { date: '2026-07-28', title: 'Easy Run', duration_min: 60, summary: 'Easy hour, HR 140 average.' },
            { date: '2026-07-27', title: 'Max Strength A', duration_min: 60, summary: 'Back squat 245×5×4, split squats, pull-ups. All sets clean.' },
          ],
        }),
        get_training_blocks: () => ({
          blocks: [{
            name: 'Base 1', phase: 'base', start_date: '2026-07-13', end_date_exclusive: '2026-10-05',
            weekly_targets: { cardio_minutes: 480, strength_sessions: 2 },
            progress: { week: 4, of: 12, to_date: { cardio_minutes: { actual: 900, target: 1440 }, strength_sessions: { actual: 6, target: 6 } } },
          }],
        }),
      },
    },
    script: [
      { kind: 'user', text: 'Look at what I actually did last week versus the plan and tell me whether I\'m on track for the block. Just tell me — don\'t change anything.' },
    ],
    expect: {
      integrity: {
        requireToolCall: { name: ['get_schedule', 'get_session_summaries', 'get_training_blocks', 'get_period_stats', 'get_workout_detail'] },
        forbidToolCalls: WRITE_TOOLS,
        fixtureUnchanged: true,
      },
    },
  },
];
