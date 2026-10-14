import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NumbersSection } from '../WeeklyReviewSections';
import type { WeeklyReviewStats } from '../../../lib/review/weekly';

// The computed numbers rendered to markup (the sections-test pattern): plain
// labels and the figures the server sent, nothing interpreted.

const STATS: WeeklyReviewStats = {
  week: { start: '2026-09-21', end: '2026-09-27' },
  asOf: '2026-09-27',
  plan: { planned: 2, completed: 1, minutesPlanned: 105, minutesDone: 60, misses: [] },
  prs: [{ exerciseName: 'Bench Press', kind: 'oneRM', date: '2026-09-23', detail: 'est. best single lift 100 (90 × 3), up from 95 on Sep 1' }],
  weightUnit: 'kg',
  physiology: {
    load: { source: 'trainingLoad', acute7d: 200, chronicWeeklyAvg28d: 50, ratio: 4 },
    hrv: { mean7d: null, mean28d: 61 },
    zoneMinutes: [10, 20, 0, 0, 0],
    zoneMethod: 'device',
    tonnageByWeek: [{ weekStart: '2026-09-14', tonnageLb: null }, { weekStart: '2026-09-21', tonnageLb: 2205 }],
  },
};

describe('NumbersSection', () => {
  it('shows the PRs, the load ratio, HRV, zones and tonnage in the athlete\'s unit', () => {
    const html = renderToStaticMarkup(<NumbersSection stats={STATS} />);
    expect(html).toContain('Bench Press');
    expect(html).toContain('est. best single lift 100 (90 × 3), up from 95 on Sep 1');
    expect(html).toContain('Lifts in kg.');
    expect(html).toMatch(/data-testid="weekly-review-acwr">4\.00</);
    expect(html).toContain('no reading, 7 d');
    expect(html).toContain('61 ms');
    expect(html).toContain('10 / 20 / 0 / 0 / 0');
    // 2205 lb shown in kg, whole; the empty week is a dash.
    expect(html).toContain('1,000 kg');
    expect(html).toContain('—');
    expect(html).toContain('Load as of Sun Sep 27.');
  });

  it('says so when there are no PRs and nothing was measured, and a missing baseline reads n/a', () => {
    const empty = renderToStaticMarkup(<NumbersSection stats={{
      ...STATS, prs: [],
      physiology: { load: null, hrv: null, zoneMinutes: null, zoneMethod: null, tonnageByWeek: [] },
    }} />);
    expect(empty).toContain('No PRs this week.');
    expect(empty).toContain('No measured data in the five weeks to Sun Sep 27.');
    expect(empty).not.toContain('weekly-review-load');

    const noBaseline = renderToStaticMarkup(<NumbersSection stats={{
      ...STATS, physiology: { ...STATS.physiology, load: { source: 'cardioMinutes', acute7d: 90, chronicWeeklyAvg28d: 0, ratio: null } },
    }} />);
    expect(noBaseline).toContain('n/a, no 28 d baseline');
    expect(noBaseline).toContain('cardio min');
  });
});
