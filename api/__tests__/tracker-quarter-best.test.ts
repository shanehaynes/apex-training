import { describe, it, expect } from 'vitest';
import { buildBootstrap } from '../_lib/trackerSession';
import type { SetLogRow, WorkoutSessionRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

type Admin = Parameters<typeof buildBootstrap>[0];

// The bootstrap carries each strength exercise's best set this quarter
// (docs/specs/tracker-quarter-pr, R1): values here, field names in
// ios-fixture-shape.test.ts.

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
  id: 'evt-1', date: '2026-11-11', title: 'Push', type: 'weights', estimatedDuration: 45, description: '',
  difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  exercises: [
    { id: 'bench', name: 'Bench Press', category: 'strength', sets: 2, reps: '5', weight: '185 lb' },
    { id: 'hips', name: 'Hip Flow', category: 'mobility', sets: 1, duration: '90s' },
  ],
} as unknown as WorkoutEvent;

function setRow(over: Partial<SetLogRow>): Record<string, unknown> {
  return {
    event_id: 'evt-0', event_date: '2026-10-14', section: 'exercise', exercise_id: 'bench', exercise_name: 'Bench Press',
    set_number: 1, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: '185 lb', actual_reps: '5', actual_duration: null, is_autofilled: false, is_warmup: false,
    ...over,
  };
}

const OPEN = { started_at: '2026-11-11T09:30:00.000Z', finished_at: null } as WorkoutSessionRow;
const FINISHED = { started_at: '2026-11-11T09:30:00.000Z', finished_at: '2026-11-11T10:30:00.000Z' } as WorkoutSessionRow;

describe('bootstrap quarterBest', () => {
  it('is the best set this quarter before the session, as logged, on strength exercises only', async () => {
    const admin = makeAdmin({
      workout_set_logs: [
        setRow({ event_date: '2026-11-04', actual_weight: '205 lb', actual_reps: '3' }),
        setRow({ event_date: '2026-10-14' }),
        setRow({ event_date: '2026-09-30', actual_weight: '315 lb', actual_reps: '1' }),
        setRow({ event_date: '2026-11-11', actual_weight: '400 lb', actual_reps: '1' }),
        setRow({ exercise_id: 'hips', exercise_name: 'Hip Flow', actual_weight: null, actual_reps: null, actual_duration: '120' }),
      ],
    });
    const boot = await buildBootstrap(admin, 'u1', OPEN, EVENT);
    const [bench, hips] = boot.groups[0].exercises;
    expect(bench.quarterBest).toEqual({ weight: '205 lb', reps: '3', duration: '', date: '2026-11-04', quarter: 4 });
    expect(hips.quarterBest).toBeNull();
  });

  it('is null with nothing logged this quarter', async () => {
    const admin = makeAdmin({ workout_set_logs: [setRow({ event_date: '2026-09-30' })] });
    const boot = await buildBootstrap(admin, 'u1', OPEN, EVENT);
    expect(boot.groups[0].exercises[0].quarterBest).toBeNull();
  });

  it('ranks under the profile unit once it is read: a bare 100 is 100 kg for a kg lifter', async () => {
    const admin = makeAdmin({
      profiles: [{ id: 'u1', weight_unit: 'kg', body_weight_lb: null }],
      workout_set_logs: [
        setRow({ event_date: '2026-11-04', actual_weight: '100', actual_reps: '5' }),
        setRow({ event_date: '2026-10-14', actual_weight: '150 lb', actual_reps: '5' }),
      ],
    });
    const boot = await buildBootstrap(admin, 'u1', FINISHED, EVENT);
    expect(boot.groups[0].exercises[0].quarterBest).toMatchObject({ weight: '100', date: '2026-11-04' });
  });
});
