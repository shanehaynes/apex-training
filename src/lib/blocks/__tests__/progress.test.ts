import { describe, expect, it } from 'vitest';
import { parseISO } from 'date-fns';
import { computeBlockProgress } from '../progress';
import type { BlockProgressInputs, TargetAttainment } from '../progress';
import type { TrainingBlock } from '../../../types/blocks';
import type { CardioLogRow, CompletionRow, WorkoutSessionRow } from '../../db/types';
import type { WorkoutEvent } from '../../../types/workout';

// 8-week block, Mon 2026-03-02 → Mon 2026-04-27 (exclusive).
const block = (over: Partial<TrainingBlock> = {}): TrainingBlock => ({
  id: 'blk-1',
  name: 'Fall Aerobic Foundation',
  intent: 'Build the aerobic base',
  startDate: '2026-03-02',
  endDateExclusive: '2026-04-27',
  weeklyTargets: {},
  ...over,
});

const completion = (over: Partial<CompletionRow> & Pick<CompletionRow, 'event_date' | 'event_type'>): CompletionRow => ({
  event_id: `e-${over.event_date}-${over.event_type}`,
  event_title: 'Session',
  duration_minutes: 60,
  is_completed: true,
  completed_at: `${over.event_date}T12:00:00Z`,
  updated_at: `${over.event_date}T12:00:00Z`,
  ...over,
});

const cardioLog = (over: Partial<CardioLogRow> & Pick<CardioLogRow, 'event_date'>): CardioLogRow => ({
  event_id: `e-${over.event_date}`,
  section: 'exercise',
  exercise_id: 'x1',
  exercise_name: 'Uphill hike',
  duration_minutes: 60,
  distance: null,
  elevation_gain: null,
  avg_heart_rate: null,
  is_autofilled: false,
  ...over,
});

const plannedEvent = (over: Partial<WorkoutEvent> & Pick<WorkoutEvent, 'date' | 'type'>): WorkoutEvent => ({
  id: `p-${over.date}-${over.type}`,
  title: 'Planned',
  estimatedDuration: 60,
  description: '',
  exercises: [],
  difficulty: 3,
  tags: [],
  isCompleted: false,
  isRecurring: false,
  ...over,
});

function run(over: Partial<BlockProgressInputs> = {}, today = parseISO('2026-03-30')) {
  return computeBlockProgress(
    {
      block: block(),
      completions: [],
      sessions: [],
      setLogs: [],
      cardioLogs: [],
      plannedEvents: [],
      period: { startDate: '', endDateExclusive: '', periodType: 'block', label: '', weeksInPeriod: 0 },
      ...over,
    },
    today,
  );
}

const find = (list: TargetAttainment[], key: string) => list.find(a => a.key === key);

describe('block-to-date proration', () => {
  // The rule that makes the number honest: week 1 of an 8-week block must not
  // read as 12% just because the other 7 weeks haven't happened yet.
  it('prorates by ELAPSED weeks, not block length', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { cardioMinutes: 300 } }),
        completions: [
          completion({ event_date: '2026-03-03', event_type: 'cardio', duration_minutes: 300 }),
        ],
      },
      parseISO('2026-03-09'), // exactly one completed week
    );

    expect(progress.weeksElapsed).toBe(1);
    const cardio = find(progress.toDate.attainment, 'cardioMinutes')!;
    expect(cardio.targetForWindow).toBe(300);  // 300 × 1 week, not × 8
    expect(cardio.actual).toBe(300);
    expect(cardio.pct).toBe(1);
  });

  it('scales the window target with elapsed weeks', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { cardioMinutes: 300 } }),
        completions: [
          completion({ event_date: '2026-03-03', event_type: 'cardio', duration_minutes: 300 }),
          completion({ event_date: '2026-03-10', event_type: 'cardio', duration_minutes: 150 }),
        ],
      },
      parseISO('2026-03-16'), // two completed weeks
    );

    const cardio = find(progress.toDate.attainment, 'cardioMinutes')!;
    expect(cardio.targetForWindow).toBe(600);
    expect(cardio.actual).toBe(450);
    expect(cardio.pct).toBeCloseTo(0.75);
  });
});

describe('authored vs derived targets', () => {
  it('an authored target wins over the planned calendar', () => {
    const progress = run({
      block: block({ weeklyTargets: { cardioMinutes: 300 } }),
      plannedEvents: [plannedEvent({ date: '2026-03-03', type: 'cardio', estimatedDuration: 999 })],
    });
    const cardio = find(progress.toDate.attainment, 'cardioMinutes')!;
    expect(cardio.source).toBe('authored');
    expect(cardio.target).toBe(300);
  });

  it('falls back to the planned calendar when a key is unset', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: {} }),
        plannedEvents: [
          plannedEvent({ date: '2026-03-03', type: 'cardio', estimatedDuration: 120 }),
          plannedEvent({ date: '2026-03-05', type: 'cardio', estimatedDuration: 80 }),
        ],
      },
      parseISO('2026-03-09'),
    );
    const cardio = find(progress.toDate.attainment, 'cardioMinutes')!;
    expect(cardio.source).toBe('derived');
    expect(cardio.target).toBe(200);
  });

  it('omits a target that is neither authored nor on the calendar', () => {
    const progress = run();
    expect(find(progress.toDate.attainment, 'cardioMinutes')).toBeUndefined();
  });
});

describe('never divides by zero', () => {
  it('yields no row rather than NaN or Infinity when the target is zero', () => {
    const progress = run({
      block: block({ weeklyTargets: { cardioMinutes: 0 } }),
      completions: [completion({ event_date: '2026-03-03', event_type: 'cardio' })],
    });
    expect(find(progress.toDate.attainment, 'cardioMinutes')).toBeUndefined();
    for (const a of progress.toDate.attainment) {
      expect(a.pct === null || Number.isFinite(a.pct)).toBe(true);
    }
  });

  it('an empty block gives 0%, not NaN', () => {
    const progress = run({ block: block({ weeklyTargets: { cardioMinutes: 300 } }) });
    const cardio = find(progress.toDate.attainment, 'cardioMinutes')!;
    expect(cardio.actual).toBe(0);
    expect(cardio.pct).toBe(0);
  });

  it('a block that has not started yet reports zero elapsed weeks', () => {
    const progress = run({ block: block({ weeklyTargets: { cardioMinutes: 300 } }) }, parseISO('2026-02-23'));
    expect(progress.weeksElapsed).toBe(0);
    expect(progress.currentWeek).toBeNull();
    // No completed weeks means no window to prorate over — no misleading 0%.
    expect(find(progress.toDate.attainment, 'cardioMinutes')?.targetForWindow).toBe(0);
  });
});

describe('units are never converted', () => {
  it('elevation logged in m does not count toward a ft target', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { vert: { value: 2000, unit: 'ft' } } }),
        cardioLogs: [
          cardioLog({ event_date: '2026-03-03', elevation_gain: '1500 ft' }),
          cardioLog({ event_date: '2026-03-04', elevation_gain: '600 m' }),
        ],
      },
      parseISO('2026-03-09'),
    );
    const vert = find(progress.toDate.attainment, 'vert')!;
    expect(vert.unit).toBe('ft');
    expect(vert.actual).toBe(1500);              // the 600 m is NOT folded in
    expect(vert.unmatchedUnits).toEqual({ m: 600 });
  });

  it('distance sums only the matching unit', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { distance: { value: 10, unit: 'mi' } } }),
        cardioLogs: [
          cardioLog({ event_date: '2026-03-03', distance: '5 mi' }),
          cardioLog({ event_date: '2026-03-04', distance: '8 km' }),
        ],
      },
      parseISO('2026-03-09'),
    );
    const dist = find(progress.toDate.attainment, 'distance')!;
    expect(dist.actual).toBe(5);
    expect(dist.pct).toBe(0.5);
    expect(dist.unmatchedUnits).toEqual({ km: 8 });
  });
});

describe('session counting', () => {
  it('climbingSessions sums indoor and outdoor climbing', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { climbingSessions: 2 } }),
        completions: [
          completion({ event_date: '2026-03-03', event_type: 'climbing' }),
          completion({ event_date: '2026-03-05', event_type: 'outdoor-climbing' }),
        ],
      },
      parseISO('2026-03-09'),
    );
    expect(find(progress.toDate.attainment, 'climbingSessions')!.actual).toBe(2);
  });

  it('ignores completions marked not completed', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { strengthSessions: 2 } }),
        completions: [
          completion({ event_date: '2026-03-03', event_type: 'weights' }),
          completion({ event_date: '2026-03-05', event_type: 'weights', is_completed: false }),
        ],
      },
      parseISO('2026-03-09'),
    );
    expect(find(progress.toDate.attainment, 'strengthSessions')!.actual).toBe(1);
  });
});

describe('duration precedence', () => {
  // Same rule as durationMinutesFor: real stopwatch time beats the estimate.
  it('tracked session seconds win over the completion estimate', () => {
    const session: WorkoutSessionRow = {
      id: 's1',
      event_id: 'e-2026-03-03-cardio',
      event_date: '2026-03-03',
      started_at: '2026-03-03T10:00:00Z',
      finished_at: '2026-03-03T11:30:00Z',
      total_duration_seconds: 5400, // 90 min
      coach_summary: null,
      updated_at: '2026-03-03T11:30:00Z',
      template_id: null,
      score_type: null,
      score_time_seconds: null,
      score_rounds: null,
      score_reps: null,
    };
    const progress = run(
      {
        block: block({ weeklyTargets: { cardioMinutes: 90 } }),
        completions: [completion({ event_date: '2026-03-03', event_type: 'cardio', duration_minutes: 60 })],
        sessions: [session],
      },
      parseISO('2026-03-09'),
    );
    expect(find(progress.toDate.attainment, 'cardioMinutes')!.actual).toBe(90);
  });
});

describe('per-week breakdown', () => {
  it('marks completed weeks and attributes work to the right week', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { cardioMinutes: 100 } }),
        completions: [
          completion({ event_date: '2026-03-03', event_type: 'cardio', duration_minutes: 100 }),
          completion({ event_date: '2026-03-11', event_type: 'cardio', duration_minutes: 50 }),
        ],
      },
      parseISO('2026-03-16'),
    );
    expect(progress.weeks).toHaveLength(8);
    expect(progress.weeks[0].isComplete).toBe(true);
    expect(progress.weeks[2].isComplete).toBe(false);
    expect(find(progress.weeks[0].attainment, 'cardioMinutes')!.actual).toBe(100);
    expect(find(progress.weeks[1].attainment, 'cardioMinutes')!.actual).toBe(50);
    expect(find(progress.weeks[2].attainment, 'cardioMinutes')!.actual).toBe(0);
  });
});

describe('longSessionMinutes', () => {
  it('is a per-session threshold, not a weekly sum', () => {
    const progress = run(
      {
        block: block({ weeklyTargets: { longSessionMinutes: 240 } }),
        completions: [
          completion({ event_date: '2026-03-03', event_type: 'cardio', duration_minutes: 120 }),
          completion({ event_date: '2026-03-05', event_type: 'cardio', duration_minutes: 180 }),
        ],
      },
      parseISO('2026-03-09'),
    );
    const long = find(progress.toDate.attainment, 'longSessionMinutes')!;
    expect(long.targetForWindow).toBe(240);   // the threshold, not 240 × weeks
    expect(long.actual).toBe(180);            // the longest, not the sum
    expect(long.pct).toBeCloseTo(0.75);
  });
});
