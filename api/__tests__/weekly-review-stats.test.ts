import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeWeeklyStats, fetchWeeklyInputs, physiologyAsOf } from '../_lib/review/weekly';
import { fetchExpandedSchedule } from '../_lib/mcp/data';
import { fetchPeriodInputs } from '../_lib/reviewData';
import { fetchPhysiologyInputs } from '../_lib/coach/physiology';
import type { PeriodStats, StatsPeriod } from '../../src/lib/review/types';
import type { PhysiologyInputs } from '../../src/lib/physiology';
import type { WorkoutEvent } from '../../src/types/workout';

// The weekly review's computed `stats` (keyless lane): the physiology panel
// is anchored on the reviewed week's end, not today, and the stats reshape
// what the panel and the period stats already computed.

vi.mock('../_lib/mcp/data.js', () => ({ fetchExpandedSchedule: vi.fn() }));
vi.mock('../_lib/reviewData.js', () => ({ fetchPeriodInputs: vi.fn() }));
vi.mock('../_lib/coach/physiology.js', () => ({ fetchPhysiologyInputs: vi.fn() }));
vi.mock('../_lib/coach/memory.js', () => ({ listConfirmed: vi.fn(async () => []), toPromptEntries: (rows: unknown[]) => rows }));

const TODAY = '2026-10-14'; // Wednesday, three weeks after the reviewed week
const PAST = { start: '2026-09-21', end: '2026-09-27' };
const CURRENT = { start: '2026-10-12', end: '2026-10-18' };

const activity = (eventDate: string, trainingLoad: number, hrv: number) =>
  ({ eventId: `a-${eventDate}`, eventDate, durationSec: 3600, avgHr: null, hrZones: null, trainingLoad, hrv });
const setLog = (eventDate: string, weight: string, reps: string) =>
  ({ eventDate, actualWeight: weight, actualReps: reps, actualDuration: null, isAutofilled: false, isWarmup: false });

// Two easy sessions in the reviewed week, one huge one this week. Anchored
// on today, the reviewed week's acute load would be this week's 500.
function physiologyFor(asOf: string): PhysiologyInputs {
  return {
    today: asOf,
    activities: [activity('2026-09-22', 100, 60), activity('2026-09-25', 100, 70), activity('2026-10-12', 500, 40)],
    cardioLogs: [],
    setLogs: [setLog('2026-09-23', '100', '10'), setLog('2026-10-13', '200', '10')],
    thresholdHr: null,
    maxHr: null,
  };
}

const admin = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }) };
    return chain;
  },
} as never;

const EVENT: WorkoutEvent = {
  id: 'mon-push', type: 'weights', title: 'Push Day', date: '2026-09-21', estimatedDuration: 60,
  description: '', exercises: [], difficulty: 3, tags: [], isCompleted: true, isRecurring: false,
};

beforeEach(() => {
  vi.mocked(fetchPhysiologyInputs).mockReset();
  vi.mocked(fetchPhysiologyInputs).mockImplementation(async (_db, _u, asOf) => physiologyFor(asOf));
  vi.mocked(fetchExpandedSchedule).mockResolvedValue({
    occurrences: [EVENT, { ...EVENT, id: 'wed-run', date: '2026-09-23', isCompleted: false, estimatedDuration: 45 }],
    definitions: new Map(), anchorDates: new Map(),
  });
  vi.mocked(fetchPeriodInputs).mockResolvedValue({
    period: { periodType: 'block', startDate: PAST.start, endDateExclusive: '2026-09-28', label: 'w', weeksInPeriod: 1 },
    completions: [], sessions: [], setLogs: [], cardioLogs: [],
  });
});

describe('physiologyAsOf', () => {
  it('is the week\'s Sunday for a finished week and today for the running one', () => {
    expect(physiologyAsOf(TODAY, PAST)).toBe('2026-09-27');
    expect(physiologyAsOf(TODAY, CURRENT)).toBe(TODAY);
    expect(physiologyAsOf('2026-09-27', PAST)).toBe('2026-09-27');
  });
});

describe('fetchWeeklyInputs physiology anchor', () => {
  it('computes an old week\'s physiology as of that week\'s end, not today', async () => {
    const result = await fetchWeeklyInputs(admin, 'u1', TODAY, PAST);
    expect(fetchPhysiologyInputs).toHaveBeenCalledWith(admin, 'u1', '2026-09-27');
    const p = result.weeklyStats.physiology;
    expect(result.weeklyStats.asOf).toBe('2026-09-27');
    // Sep 21–27: 100 + 100. The 28 days to Sep 27 hold only those two.
    expect(p.load).toEqual({ source: 'trainingLoad', acute7d: 200, chronicWeeklyAvg28d: 50, ratio: 4 });
    expect(p.hrv).toEqual({ mean7d: 65, mean28d: 65 });
    expect(p.tonnageByWeek.map(w => w.weekStart)).toEqual(['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']);
    expect(p.tonnageByWeek.at(-1)).toEqual({ weekStart: '2026-09-21', tonnageLb: 1000 });
    // The prompt's panel is the same anchored computation.
    expect(result.physiology).toContain('acute 7d 200');
    expect(result.physiology).not.toContain('500');
  });

  it('anchors the running week on today', async () => {
    const result = await fetchWeeklyInputs(admin, 'u1', TODAY, CURRENT);
    expect(fetchPhysiologyInputs).toHaveBeenCalledWith(admin, 'u1', TODAY);
    expect(result.weeklyStats.asOf).toBe(TODAY);
    expect(result.weeklyStats.physiology.load?.acute7d).toBe(500);
    expect(result.weeklyStats.physiology.tonnageByWeek.at(-1)).toEqual({ weekStart: '2026-10-12', tonnageLb: 2000 });
  });

  it('carries plan vs done, and null physiology sections when nothing was measured', async () => {
    vi.mocked(fetchPhysiologyInputs).mockImplementation(async (_db, _u, asOf) =>
      ({ today: asOf, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null }));
    const { weeklyStats } = await fetchWeeklyInputs(admin, 'u1', TODAY, PAST);
    expect(weeklyStats.week).toEqual(PAST);
    expect(weeklyStats.plan).toMatchObject({ planned: 2, completed: 1, minutesPlanned: 105, minutesDone: 60 });
    expect(weeklyStats.plan.misses.map(m => m.eventId)).toEqual(['wed-run']);
    expect(weeklyStats.physiology).toEqual({ load: null, hrv: null, zoneMinutes: null, zoneMethod: null, tonnageByWeek: [] });
  });
});

describe('computeWeeklyStats', () => {
  it('describes each PR in the athlete\'s unit and takes the reviewed week\'s zone minutes', () => {
    const stats = {
      strength: { displayUnit: 'kg' },
      prs: [{
        kind: 'oneRM', exerciseName: 'Bench Press', date: '2026-09-23', previousDate: '2026-09-01',
        estimatedOneRM: 220.46, weight: 198.42, reps: 3, previousOneRM: 209.44,
      }],
    } as unknown as PeriodStats<StatsPeriod>;
    const result = computeWeeklyStats({
      window: PAST,
      asOf: PAST.end,
      plan: { planned: 0, completed: 0, minutesPlanned: 0, minutesDone: 0, misses: [] },
      stats,
      panel: {
        weekStarts: ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'],
        today: PAST.end,
        zoneMethod: 'avgHr',
        zoneMinutesByWeek: [
          { weekStart: '2026-09-14', minutes: [9, 9, 9, 9, 9] },
          { weekStart: '2026-09-21', minutes: [10, 20, 0, 0, 0] },
        ],
      },
    });
    expect(result.weightUnit).toBe('kg');
    expect(result.prs).toEqual([{
      exerciseName: 'Bench Press', kind: 'oneRM', date: '2026-09-23',
      detail: 'est. best single lift 100 (90 × 3), up from 95 on Sep 1',
    }]);
    expect(result.physiology.zoneMinutes).toEqual([10, 20, 0, 0, 0]);
    expect(result.physiology.zoneMethod).toBe('avgHr');
  });
});
