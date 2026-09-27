import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityFromRow, fetchPhysiologyInputs } from '../_lib/coach/physiology';

// The physiology fetch is an enhancement to the prompt: it maps the four
// sources onto the pure module's inputs and, on any failure, hands back
// empty inputs with one warning instead of failing the turn.

const TODAY = '2026-09-25';

interface TableState { rows: unknown[]; error?: string }
let tables: Record<string, TableState>;
let profile: { data: Record<string, unknown> | null; error: { message: string } | null };
let filters: Array<{ table: string; op: string; args: unknown[] }>;

function makeAdmin() {
  return {
    from(table: string) {
      const record = (op: string) => (...args: unknown[]) => { filters.push({ table, op, args }); return chain; };
      const chain = {
        select: record('select'), eq: record('eq'), gte: record('gte'), lte: record('lte'),
        order: record('order'), range: record('range'),
        maybeSingle: async () => profile,
        then(resolve: (v: unknown) => void) {
          const state = tables[table] ?? { rows: [] };
          resolve(state.error ? { data: null, error: { message: state.error } } : { data: state.rows, error: null });
        },
      };
      return chain;
    },
  } as never;
}

beforeEach(() => {
  filters = [];
  profile = { data: { threshold_hr: 162, max_hr: 190 }, error: null };
  tables = {
    activity_streams: { rows: [
      { event_id: 'evt-1', event_date: '2026-09-22', summary: { sport: 100, durationSec: 2700, avgHr: 141, hrZones: [600, 1800, 300, 0, 0], trainingLoad: '87', hrv: 61 } },
      { event_id: 'evt-2', event_date: '2026-09-23', summary: null },
    ] },
    workout_cardio_logs: { rows: [
      { event_id: 'evt-1', event_date: '2026-09-22', avg_heart_rate: 141, duration_minutes: 45 },
    ] },
    workout_set_logs: { rows: [
      { event_date: '2026-09-21', actual_weight: '185', actual_reps: '5', actual_duration: null, is_autofilled: false },
    ] },
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('fetchPhysiologyInputs', () => {
  it('maps the four sources onto the pure inputs for the five-week window', async () => {
    const inputs = await fetchPhysiologyInputs(makeAdmin(), 'u1', TODAY);
    expect(inputs).toEqual({
      today: TODAY,
      activities: [
        { eventId: 'evt-1', eventDate: '2026-09-22', durationSec: 2700, avgHr: 141, hrZones: [600, 1800, 300, 0, 0], trainingLoad: 87, hrv: 61 },
        { eventId: 'evt-2', eventDate: '2026-09-23', durationSec: null, avgHr: null, hrZones: null, trainingLoad: null, hrv: null },
      ],
      cardioLogs: [{ eventId: 'evt-1', eventDate: '2026-09-22', avgHeartRate: 141, durationMinutes: 45 }],
      setLogs: [{ eventDate: '2026-09-21', actualWeight: '185', actualReps: '5', actualDuration: null, isAutofilled: false }],
      thresholdHr: 162,
      maxHr: 190,
    });
    expect(console.warn).not.toHaveBeenCalled();

    // Window: the Monday four weeks before this week's Monday, through today.
    for (const table of ['activity_streams', 'workout_cardio_logs', 'workout_set_logs']) {
      expect(filters).toContainEqual({ table, op: 'gte', args: ['event_date', '2026-08-24'] });
      expect(filters).toContainEqual({ table, op: 'lte', args: ['event_date', TODAY] });
      expect(filters).toContainEqual({ table, op: 'eq', args: ['user_id', 'u1'] });
    }
    // Only logged actuals: autofilled zero-fills are excluded at the query.
    expect(filters).toContainEqual({ table: 'workout_set_logs', op: 'eq', args: ['is_autofilled', false] });
    expect(filters).toContainEqual({ table: 'workout_cardio_logs', op: 'eq', args: ['is_autofilled', false] });
    // The heavy streams column stays out of the select.
    const streamSelect = filters.find(f => f.table === 'activity_streams' && f.op === 'select');
    expect(streamSelect?.args[0]).toBe('event_id,event_date,summary');
  });

  it('degrades to empty inputs with one warning when a table read fails', async () => {
    tables.workout_set_logs = { rows: [], error: 'relation is being vacuumed' };
    const inputs = await fetchPhysiologyInputs(makeAdmin(), 'u1', TODAY);
    expect(inputs).toEqual({ today: TODAY, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toBe('[api/chat] physiology unavailable for the prompt:');
    expect(vi.mocked(console.warn).mock.calls[0][1]).toContain('workout_set_logs fetch failed');
  });

  it('degrades the same way when the profile read fails, and tolerates a missing profile', async () => {
    profile = { data: null, error: { message: 'timeout' } };
    expect(await fetchPhysiologyInputs(makeAdmin(), 'u1', TODAY)).toEqual({
      today: TODAY, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null,
    });
    expect(console.warn).toHaveBeenCalledTimes(1);

    profile = { data: null, error: null };
    const inputs = await fetchPhysiologyInputs(makeAdmin(), 'u1', TODAY);
    expect(inputs.thresholdHr).toBeNull();
    expect(inputs.maxHr).toBeNull();
    expect(inputs.activities).toHaveLength(2);
  });
});

describe('activityFromRow', () => {
  it('reads numbers the provider sent as strings and leaves hrZones raw for the pure parser', () => {
    const a = activityFromRow({ event_id: 'e', event_date: '2026-09-01', summary: { durationSec: '3600', avgHr: 'n/a', hrv: 58.4, hrZones: { z1: 1 } } });
    expect(a).toEqual({ eventId: 'e', eventDate: '2026-09-01', durationSec: 3600, avgHr: null, hrZones: { z1: 1 }, trainingLoad: null, hrv: 58.4 });
  });
});
