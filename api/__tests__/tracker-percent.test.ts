import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildBootstrap } from '../_lib/trackerSession';
import type { SetLogRow, WorkoutSessionRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

type Admin = Parameters<typeof buildBootstrap>[0];

// The bootstrap resolves a percentage target server-side (D-008): every
// client renders the number it was handed. 80% of the best prior estimated
// 1RM, read under the profile's weight context and rounded to its plate step.

/** A chainable fake that applies eq / lt / in filters, and records which tables were read. */
function makeAdmin(fixtures: Record<string, Record<string, unknown>[]>, reads: string[] = []): Admin {
  return {
    from(table: string) {
      reads.push(table);
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

function event(weight: string): WorkoutEvent {
  return {
    id: 'evt-1', date: '2026-08-20', title: 'Bench day', type: 'weights', estimatedDuration: 45, description: '',
    difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
    exercises: [{ id: 'bench', name: 'Bench Press', category: 'strength', sets: 2, reps: '5', weight }],
  } as unknown as WorkoutEvent;
}

function setRow(over: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'evt-0', event_date: '2026-08-10', section: 'exercise', exercise_id: 'bench', exercise_name: 'Bench Press',
    set_number: 1, planned_weight: null, planned_reps: '1', planned_duration: null,
    actual_weight: '230', actual_reps: '1', actual_duration: null, is_autofilled: false, is_warmup: false,
    ...over,
  } as SetLogRow;
}

const OPEN = { started_at: '2026-08-20T09:30:00.000Z', finished_at: null } as WorkoutSessionRow;

const setsOf = (boot: Awaited<ReturnType<typeof buildBootstrap>>) => boot.groups[0].exercises[0].sets;

afterEach(() => vi.restoreAllMocks());

describe('bootstrap resolves percentage targets', () => {
  it('"80%" of a 230 lb single is 185 under a pounds profile', async () => {
    const admin = makeAdmin({
      profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }],
      workout_set_logs: [setRow({})] as unknown as Record<string, unknown>[],
    });
    const boot = await buildBootstrap(admin, 'u1', OPEN, event('80%'));
    expect(setsOf(boot).map(s => s.resolvedPlannedWeight)).toEqual(['185', '185']);
    // The plan itself is untouched: the raw target is still what was written.
    expect(setsOf(boot)[0].planned.targetWeight).toBe('80%');
  });

  it('reads history and rounds under the profile unit: a bare 100 is 100 kg, 80% is 80', async () => {
    const admin = makeAdmin({
      profiles: [{ id: 'u1', weight_unit: 'kg', body_weight_lb: null }],
      workout_set_logs: [setRow({ actual_weight: '100' })] as unknown as Record<string, unknown>[],
    });
    const boot = await buildBootstrap(admin, 'u1', OPEN, event('80%'));
    expect(setsOf(boot)[0].resolvedPlannedWeight).toBe('80');
  });

  it("today's own sets do not move today's target — only prior history counts", async () => {
    const admin = makeAdmin({
      profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }],
      workout_set_logs: [
        setRow({}),
        setRow({ event_id: 'evt-1', event_date: '2026-08-20', actual_weight: '300' }),
      ] as unknown as Record<string, unknown>[],
    });
    const boot = await buildBootstrap(admin, 'u1', OPEN, event('80%'));
    expect(setsOf(boot)[0].resolvedPlannedWeight).toBe('185');
  });

  it('with no history the field is absent', async () => {
    const admin = makeAdmin({ profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }] });
    const boot = await buildBootstrap(admin, 'u1', OPEN, event('80%'));
    for (const set of setsOf(boot)) expect(set).not.toHaveProperty('resolvedPlannedWeight');
  });

  it('a plan without a percentage does not read the profile for an open session', async () => {
    const reads: string[] = [];
    const admin = makeAdmin({ workout_set_logs: [setRow({})] as unknown as Record<string, unknown>[] }, reads);
    const boot = await buildBootstrap(admin, 'u1', OPEN, event('185'));
    expect(reads).not.toContain('profiles');
    expect(setsOf(boot)[0]).not.toHaveProperty('resolvedPlannedWeight');
  });
});
