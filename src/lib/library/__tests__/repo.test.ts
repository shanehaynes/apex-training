import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetLogRow } from '../../db/types';
import { MAX_ROWS } from '../../db/__tests__/postgrestStub';

const stub = await vi.hoisted(async () => {
  const { createPostgrestStub } = await import('../../db/__tests__/postgrestStub');
  return createPostgrestStub();
});
vi.mock('../../supabaseClient', () => ({ supabase: stub.client }));

const { fetchExerciseHistory } = await import('../repo');
const { buildExerciseStats } = await import('../stats');
const { tables, ranges, orders, failPage, reset } = stub;

function setRow(i: number, weight: number, event_date = '2026-01-01', reps = '5'): SetLogRow {
  return {
    event_id: `e${i}`, event_date, section: 'exercise',
    exercise_id: 'x', exercise_name: 'Bench Press', set_number: i,
    planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: `${weight} lb`, actual_reps: reps, actual_duration: null,
    is_autofilled: false,
  };
}

beforeEach(() => reset());

describe('fetchExerciseHistory', () => {
  it('reads past max_rows, so a best on the second page is the PR', async () => {
    // 1000 light sets fill the first page; the heaviest set ever is row 1001.
    tables.workout_set_logs = [
      ...Array.from({ length: MAX_ROWS }, (_, i) => setRow(i, 100)),
      setRow(MAX_ROWS, 300, '2026-06-01'),
    ];

    const { setRows, cardioRows } = await fetchExerciseHistory(['Bench Press']);

    expect(setRows).toHaveLength(MAX_ROWS + 1);
    expect(setRows.slice(0, MAX_ROWS).some(r => r.actual_weight === '300 lb')).toBe(false);
    expect(cardioRows).toEqual([]);
    const stats = buildExerciseStats(setRows, cardioRows, { displayUnit: 'lb' });
    // Epley est. 1RM: 300 lb × 5 → 350; the page-one sets top out at 117.
    expect(stats.pr).toEqual({ display: '350', date: '2026-06-01' });
  });

  it('stops after a short page', async () => {
    tables.workout_set_logs = [setRow(0, 100)];
    await fetchExerciseHistory(['Bench Press']);
    expect(ranges).toEqual([
      ['workout_set_logs', 0, 999],
      ['workout_cardio_logs', 0, 999],
    ]);
  });

  it('asks for the page after an exactly-full one, which comes back empty', async () => {
    tables.workout_set_logs = Array.from({ length: MAX_ROWS }, (_, i) => setRow(i, 100));
    const { setRows } = await fetchExerciseHistory(['Bench Press']);
    expect(setRows).toHaveLength(MAX_ROWS);
    expect(ranges.filter(([t]) => t === 'workout_set_logs')).toEqual([
      ['workout_set_logs', 0, 999],
      ['workout_set_logs', 1000, 1999],
    ]);
  });

  it('orders by each unique key so pages never overlap, and lists sets as logged', async () => {
    // Stored out of order; one session, three sets.
    tables.workout_set_logs = [setRow(3, 205, '2026-01-01', '3'), setRow(1, 185), setRow(2, 195)]
      .map(r => ({ ...r, event_id: 'e1' }));
    const { setRows, cardioRows } = await fetchExerciseHistory(['Bench Press']);

    expect(orders.workout_set_logs).toEqual([
      'event_date asc', 'event_id asc', 'section asc', 'exercise_id asc', 'set_number asc',
    ]);
    expect(orders.workout_cardio_logs).toEqual([
      'event_date asc', 'event_id asc', 'section asc', 'exercise_id asc',
    ]);
    const { sessions } = buildExerciseStats(setRows, cardioRows, { displayUnit: 'lb' });
    expect(sessions[0].sets.map(s => s.split(' ')[0])).toEqual(['185', '195', '205']);
  });

  it('throws when a later page fails, rather than returning page one as all of history', async () => {
    tables.workout_set_logs = Array.from({ length: MAX_ROWS + 1 }, (_, i) => setRow(i, 100));
    failPage.table = 'workout_set_logs';
    failPage.from = MAX_ROWS;
    await expect(fetchExerciseHistory(['Bench Press'])).rejects.toThrow('set history load failed: boom');
  });
});
