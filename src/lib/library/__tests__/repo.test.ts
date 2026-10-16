import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetLogRow } from '../../db/types';

// A stand-in for PostgREST: every select is capped at max_rows (1000) no
// matter what the query asks for, which is what production does.
const MAX_ROWS = 1000;
const tables: Record<string, unknown[]> = {};
const ranges: Array<[string, number, number]> = [];

function query(table: string) {
  let from = 0;
  let to = Number.POSITIVE_INFINITY;
  const q = {
    select: () => q,
    in: () => q,
    order: () => q,
    limit: (n: number) => { to = n - 1; return q; },
    range: (f: number, t: number) => { from = f; to = t; ranges.push([table, f, t]); return q; },
    then: (resolve: (r: { data: unknown[]; error: null }) => void) => {
      const rows = tables[table] ?? [];
      resolve({ data: rows.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null });
    },
  };
  return q;
}

vi.mock('../../supabaseClient', () => ({ supabase: { from: (table: string) => query(table) } }));

const { fetchExerciseHistory } = await import('../repo');
const { buildExerciseStats } = await import('../stats');

function setRow(i: number, weight: number, event_date = '2026-01-01'): SetLogRow {
  return {
    event_id: `e${i}`, event_date, section: 'exercise',
    exercise_id: 'x', exercise_name: 'Bench Press', set_number: i,
    planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: `${weight} lb`, actual_reps: '5', actual_duration: null,
    is_autofilled: false,
  };
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  ranges.length = 0;
});

describe('fetchExerciseHistory', () => {
  it('reads past max_rows, so a best on the second page is the PR', async () => {
    // 1000 light sets fill the first page; the heaviest set ever is row 1001.
    tables.workout_set_logs = [
      ...Array.from({ length: MAX_ROWS }, (_, i) => setRow(i, 100)),
      setRow(MAX_ROWS, 300, '2025-06-01'),
    ];

    const { setRows, cardioRows } = await fetchExerciseHistory(['Bench Press']);

    expect(setRows).toHaveLength(MAX_ROWS + 1);
    expect(cardioRows).toEqual([]);
    const stats = buildExerciseStats(setRows, cardioRows, { displayUnit: 'lb' });
    // Epley est. 1RM: 300 lb × 5 → 350; the page-one sets top out at 117.
    expect(stats.pr).toEqual({ display: '350', date: '2025-06-01' });
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
});
