import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWeightContext, readWeightContext } from '../_lib/weightContext';
import { fetchPeriodInputs } from '../_lib/reviewData';
import { loadAnalyticsInputs } from '../_lib/analyticsData';
import { fetchPhysiologyInputs } from '../_lib/coach/physiology';
import { buildReviewPeriod } from '../../src/lib/review/stats';

type Admin = Parameters<typeof fetchWeightContext>[0];

// A chainable fake: list queries resolve to the table's rows, maybeSingle to
// the first (or an error). The profiles row is what each loader reads the
// weight context from.
function makeAdmin(fixtures: Record<string, unknown[]>, profileError?: string): Admin {
  return {
    from(table: string) {
      const rows = fixtures[table] ?? [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'lt', 'is', 'in', 'range']) builder[m] = chain;
      builder.maybeSingle = async () =>
        table === 'profiles' && profileError ? { data: null, error: { message: profileError } } : { data: rows[0] ?? null, error: null };
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
      return builder;
    },
  } as unknown as Admin;
}

afterEach(() => vi.restoreAllMocks());

describe('readWeightContext / fetchWeightContext', () => {
  it('maps the two profile columns, and reads a bad unit or body weight as the default', async () => {
    expect(await readWeightContext(makeAdmin({ profiles: [{ weight_unit: 'kg', body_weight_lb: 180.5 }] }), 'u1')).toEqual({ unit: 'kg', bodyWeightLb: 180.5 });
    expect(await readWeightContext(makeAdmin({ profiles: [{ weight_unit: 'lb', body_weight_lb: null }] }), 'u1')).toEqual({ unit: 'lb', bodyWeightLb: null });
    expect(await readWeightContext(makeAdmin({ profiles: [{ weight_unit: 'stone', body_weight_lb: -3 }] }), 'u1')).toEqual({ unit: 'lb', bodyWeightLb: null });
  });

  it('is null when the row, the column or the read is missing, and fetch falls back to pounds with one warning', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readWeightContext(makeAdmin({}), 'u1')).toBeNull();
    expect(await readWeightContext(makeAdmin({ profiles: [{ threshold_hr: 160 }] }), 'u1')).toBeNull();
    expect(await readWeightContext(makeAdmin({}, 'column profiles.weight_unit does not exist'), 'u1')).toBeNull();
    expect(await readWeightContext({ from() { throw new Error('no client'); } } as unknown as Admin, 'u1')).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
    expect(await fetchWeightContext(makeAdmin({}, 'timeout'), 'u1')).toEqual({ unit: 'lb', bodyWeightLb: null });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('loaders carry the weight context', () => {
  const profile = { weight_unit: 'kg', body_weight_lb: 180, threshold_hr: null, max_hr: null };

  it('review period inputs', async () => {
    const inputs = await fetchPeriodInputs(makeAdmin({ profiles: [profile] }), 'u1', buildReviewPeriod('month', 2026, 6));
    expect(inputs.weight).toEqual({ unit: 'kg', bodyWeightLb: 180 });
  });

  it('analytics inputs', async () => {
    const inputs = await loadAnalyticsInputs(makeAdmin({ profiles: [profile] }), 'u1', { startDate: '2026-09-01', endDateExclusive: '2026-10-01' }, { withHrZones: false, hr: { maxHr: null, thresholdHr: null } });
    expect(inputs.weight).toEqual({ unit: 'kg', bodyWeightLb: 180 });
  });

  it('physiology inputs, present only when the profile could say', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await fetchPhysiologyInputs(makeAdmin({ profiles: [profile] }), 'u1', '2026-09-25')).weight).toEqual({ unit: 'kg', bodyWeightLb: 180 });
    expect(await fetchPhysiologyInputs(makeAdmin({ profiles: [{ threshold_hr: 160, max_hr: null }] }), 'u1', '2026-09-25')).not.toHaveProperty('weight');
    expect(console.warn).not.toHaveBeenCalled();
  });
});
