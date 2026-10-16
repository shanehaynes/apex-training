import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseISO } from 'date-fns';
import type { CardioLogRow, SetLogRow } from '../../db/types';
import type { TrainingBlock } from '../../../types/blocks';
import { MAX_ROWS } from '../../db/__tests__/postgrestStub';

const stub = await vi.hoisted(async () => {
  const { createPostgrestStub } = await import('../../db/__tests__/postgrestStub');
  return createPostgrestStub();
});
vi.mock('../../supabaseClient', () => ({ supabase: stub.client }));

const { loadBlockLogs, toPeriodInputs } = await import('../repo');
const { computeBlockProgress } = await import('../progress');
const { tables, orders, failPage, reset } = stub;

// 4-week block from Mon 2026-03-02.
const block: TrainingBlock = {
  id: 'blk-1', name: 'Base', intent: '', startDate: '2026-03-02', endDateExclusive: '2026-03-30',
  weeklyTargets: { vert: { value: 2000, unit: 'ft' } },
};

const pad = (i: number) => String(i).padStart(5, '0');

const cardioLog = (i: number, elevation_gain: string): CardioLogRow => ({
  event_id: `e${pad(i)}`, event_date: '2026-03-03', section: 'exercise', exercise_id: 'x1',
  exercise_name: 'Uphill hike', duration_minutes: 10, distance: null, elevation_gain,
  avg_heart_rate: null, is_autofilled: false,
});

const setLog = (i: number): SetLogRow => ({
  event_id: `e${pad(i)}`, event_date: '2026-03-03', section: 'exercise', exercise_id: 'x2',
  exercise_name: 'Squat', set_number: 1, planned_weight: null, planned_reps: null,
  planned_duration: null, actual_weight: '100 lb', actual_reps: '5', actual_duration: null,
  is_autofilled: false,
});

beforeEach(() => reset());

describe('loadBlockLogs', () => {
  it('reads every table past max_rows, so a log after row 1000 counts toward attainment', async () => {
    // 1000 one-foot hikes fill page one; the 500 ft day is row 1001.
    tables.workout_cardio_logs = [
      ...Array.from({ length: MAX_ROWS }, (_, i) => cardioLog(i, '1 ft')),
      cardioLog(MAX_ROWS, '500 ft'),
    ];
    tables.workout_set_logs = Array.from({ length: MAX_ROWS + 1 }, (_, i) => setLog(i));
    tables.workout_completions = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ event_id: `c${pad(i)}` }));
    tables.workout_sessions = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ event_id: `s${pad(i)}`, event_date: '2026-03-03' }));

    const logs = await loadBlockLogs(block);

    expect(logs.cardioLogs).toHaveLength(MAX_ROWS + 1);
    expect(logs.setLogs).toHaveLength(MAX_ROWS + 1);
    expect(logs.completions).toHaveLength(MAX_ROWS + 1);
    expect(logs.sessions).toHaveLength(MAX_ROWS + 1);

    const progress = computeBlockProgress(
      { ...toPeriodInputs(block, logs), block, plannedEvents: [] },
      parseISO('2026-03-09'),
    );
    expect(progress.toDate.attainment.find(a => a.key === 'vert')?.actual).toBe(1500);
  });

  it('orders each table by its unique key', async () => {
    await loadBlockLogs(block);
    expect(orders).toEqual({
      workout_completions: ['event_id asc'],
      workout_sessions: ['event_date asc', 'event_id asc'],
      workout_set_logs: ['event_date asc', 'event_id asc', 'section asc', 'exercise_id asc', 'set_number asc'],
      workout_cardio_logs: ['event_date asc', 'event_id asc', 'section asc', 'exercise_id asc'],
    });
  });

  it('throws when a later page fails', async () => {
    tables.workout_set_logs = Array.from({ length: MAX_ROWS + 1 }, (_, i) => setLog(i));
    failPage.table = 'workout_set_logs';
    failPage.from = MAX_ROWS;
    await expect(loadBlockLogs(block)).rejects.toThrow('block setLogs load failed: boom');
  });
});
