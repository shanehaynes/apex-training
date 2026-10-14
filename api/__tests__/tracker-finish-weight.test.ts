import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildBootstrap, buildFinishSummary } from '../_lib/trackerSession';
import { computePeriodPRs } from '../../src/lib/review/stats';
import { weightContextFromProfile } from '../../src/lib/tracking/weight';
import type { SetLogRow, WorkoutSessionRow } from '../../src/lib/db/types';
import type { StatsPeriod } from '../../src/lib/review/types';
import type { WorkoutEvent } from '../../src/types/workout';

type Admin = Parameters<typeof buildFinishSummary>[0];

// Finish (and the finished-session bootstrap) detect records with the
// profile's weight context — the one the review reads with — so a kg
// lifter's bare "120" is 120 kg on the Finish screen exactly as it is in
// the review, and the two report the same record.

/** A chainable fake that applies eq / lt / in filters, so the occurrence's saved rows and prior history come apart. */
function makeAdmin(fixtures: Record<string, Record<string, unknown>[]>): Admin {
  return {
    from(table: string) {
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      const rows = () => (fixtures[table] ?? []).filter(row => filters.every(f => f(row)));
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'range', 'not', 'is', 'gte', 'lte']) builder[m] = chain;
      builder.eq = (column: string, value: unknown) => {
        filters.push(row => column === 'user_id' || row[column] === value);
        return builder;
      };
      builder.lt = (column: string, value: string) => {
        filters.push(row => String(row[column]) < value);
        return builder;
      };
      builder.in = (column: string, values: unknown[]) => {
        filters.push(row => values.includes(row[column]));
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
      return builder;
    },
  } as unknown as Admin;
}

const EVENT = {
  id: 'evt-1', date: '2026-08-20', title: 'Bench day', type: 'weights', estimatedDuration: 45, description: '',
  difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  exercises: [{ id: 'bench', name: 'Bench Press', category: 'strength', sets: 1, reps: '5' }],
} as unknown as WorkoutEvent;

function setRow(over: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'evt-1', event_date: '2026-08-20', section: 'exercise', exercise_id: 'bench', exercise_name: 'Bench Press',
    set_number: 1, planned_weight: null, planned_reps: '5', planned_duration: null,
    actual_weight: null, actual_reps: '5', actual_duration: null, is_autofilled: false, is_warmup: false,
    ...over,
  } as SetLogRow;
}

// Ten days ago: an explicit 100 kg × 5. Today: a bare 120 × 5 — 120 kg to a
// kg lifter (a record), 120 lb to the pounds default (well short of one).
const HISTORY = setRow({ event_id: 'evt-0', event_date: '2026-08-10', actual_weight: '100 kg' });
const TODAY = setRow({ actual_weight: '120' });

const PERIOD: StatsPeriod = {
  startDate: '2026-08-01', endDateExclusive: '2026-09-01', periodType: 'block', label: 'Aug 2026', weeksInPeriod: 4,
};

function fixtures(weightUnit: 'kg' | 'lb') {
  return {
    profiles: [{ id: 'u1', weight_unit: weightUnit, body_weight_lb: null }],
    workout_set_logs: [HISTORY, TODAY] as unknown as Record<string, unknown>[],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Finish-path records read with the profile weight context', () => {
  it("a kg lifter's Finish PRs are the review's PRs", async () => {
    const summary = await buildFinishSummary(makeAdmin(fixtures('kg')), 'u1', EVENT, 1800, null);
    const review = computePeriodPRs([HISTORY, TODAY], [], PERIOD, weightContextFromProfile({ weight_unit: 'kg' }))
      .filter(pr => pr.date === '2026-08-20');

    expect(review).toHaveLength(1);
    expect(summary.prs).toHaveLength(1);
    const { date: _date, ...reviewRecord } = review[0];
    const { description: _description, ...finishRecord } = summary.prs[0];
    expect(finishRecord).toEqual(reviewRecord);
    expect(finishRecord).toMatchObject({ kind: 'oneRM', exerciseName: 'Bench Press', reps: 5, previousDate: '2026-08-10' });
  });

  it('a pounds lifter gets no record from the same rows, in either place', async () => {
    const summary = await buildFinishSummary(makeAdmin(fixtures('lb')), 'u1', EVENT, 1800, null);
    const review = computePeriodPRs([HISTORY, TODAY], [], PERIOD, weightContextFromProfile({ weight_unit: 'lb' }))
      .filter(pr => pr.date === '2026-08-20');
    expect(review).toEqual([]);
    expect(summary.prs).toEqual([]);
  });

  it("reopening a finished session's summary reports the same records as Finish did", async () => {
    const admin = makeAdmin(fixtures('kg'));
    const finished = { finished_at: '2026-08-20T10:00:00.000Z', started_at: '2026-08-20T09:30:00.000Z' } as WorkoutSessionRow;
    const [boot, finish] = await Promise.all([
      buildBootstrap(admin, 'u1', finished, EVENT),
      buildFinishSummary(admin, 'u1', EVENT, 1800, null),
    ]);
    expect(boot.prs).toHaveLength(1);
    expect(boot.prs).toEqual(finish.prs);
  });
});
