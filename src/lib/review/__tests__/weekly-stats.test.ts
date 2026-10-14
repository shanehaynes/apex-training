import { describe, it, expect } from 'vitest';
import { isWeeklyReviewResponse, isWeeklyReviewStats, type WeeklyReviewStats } from '../weekly';

// The keyless envelope and the stats guard: a response may carry no
// document only when it carries the stats, and stats are checked whenever
// they come.

const STATS: WeeklyReviewStats = {
  week: { start: '2026-09-21', end: '2026-09-27' },
  asOf: '2026-09-27',
  plan: { planned: 2, completed: 1, minutesPlanned: 105, minutesDone: 60, misses: [{ eventId: 'wed-run', title: 'Run', date: '2026-09-23' }] },
  prs: [],
  weightUnit: 'kg',
  physiology: {
    load: { source: 'cardioMinutes', acute7d: 90, chronicWeeklyAvg28d: 0, ratio: null, historyDays: 5 },
    hrv: null,
    zoneMinutes: null,
    tonnageByWeek: [{ weekStart: '2026-09-21', tonnageLb: null }],
  },
};

const KEYLESS = { document: null, model: null, stats: STATS, warnings: [], generatedAt: '2026-10-14T08:00:00Z' };

describe('isWeeklyReviewStats', () => {
  it('accepts the computed payload and refuses a malformed section', () => {
    expect(isWeeklyReviewStats(STATS)).toBe(true);
    expect(isWeeklyReviewStats({ ...STATS, asOf: 'Sunday' })).toBe(false);
    expect(isWeeklyReviewStats({ ...STATS, weightUnit: 'stone' })).toBe(false);
    expect(isWeeklyReviewStats({ ...STATS, physiology: { ...STATS.physiology, zoneMinutes: [1, 2, 3] } })).toBe(false);
    expect(isWeeklyReviewStats({ ...STATS, physiology: { ...STATS.physiology, load: { source: 'vibes', acute7d: 1, chronicWeeklyAvg28d: 1, ratio: 1, historyDays: 1 } } })).toBe(false);
    expect(isWeeklyReviewStats({ ...STATS, plan: { planned: 1 } })).toBe(false);
  });
});

describe('isWeeklyReviewResponse, keyless', () => {
  it('takes no document and no model when the stats come with them', () => {
    expect(isWeeklyReviewResponse(KEYLESS)).toBe(true);
  });

  it('refuses no document without stats, a model without a document, and bad stats beside a document', () => {
    const { stats: _omit, ...noStats } = KEYLESS;
    expect(isWeeklyReviewResponse(noStats)).toBe(false);
    expect(isWeeklyReviewResponse({ ...KEYLESS, model: { id: 'x', label: 'X', badge: 'x' } })).toBe(false);
    expect(isWeeklyReviewResponse({ ...KEYLESS, stats: { ...STATS, prs: 'none' } })).toBe(false);
  });
});
