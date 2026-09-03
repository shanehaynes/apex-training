import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { MAX_SPECS } from '../_lib/handlers/analyticsCompute';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { loadAnalyticsInputs } from '../_lib/analyticsData';
import { makeCompletion, makeInputs, makeSpec } from '../../src/lib/analytics/__tests__/helpers';
import type { TileResult } from '../../src/lib/analytics/engine';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/analyticsData.js', () => ({ loadAnalyticsInputs: vi.fn() }));

interface State { profile: { max_hr: number | null; threshold_hr: number | null } | null; blocks: unknown[] }
let state: State;

function makeAdmin() {
  return {
    from(table: string) {
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain,
        maybeSingle: async () => ({ data: state.profile, error: null }),
        then(resolve: (v: unknown) => void) { resolve({ data: table === 'training_blocks' ? state.blocks : [], error: null }); },
      };
      return chain;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown, method = 'POST'): VercelRequest {
  return { method, headers: {}, query: {}, body } as unknown as VercelRequest;
}
function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload as { today: string; tiles: TileResult[] } };
}

const TODAY = '2026-09-15';
const sessions = makeSpec({ measure: 'session-count' }, { chartType: 'kpi', bucket: 'total' });

beforeEach(() => {
  state = { profile: { max_hr: 190, threshold_hr: null }, blocks: [] };
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  vi.mocked(loadAnalyticsInputs).mockReset();
  vi.mocked(loadAnalyticsInputs).mockResolvedValue(makeInputs({
    completions: [makeCompletion('2026-09-08', 'weights'), makeCompletion('2026-09-10', 'cardio'), makeCompletion('2026-10-02', 'weights')],
  }));
});

describe('POST /api/analytics-compute — validation', () => {
  it('405s non-POST; 400s a missing/empty/oversized specs array and a bad today', async () => {
    const a = makeRes();
    await handler(makeReq({ specs: [sessions], today: TODAY }, 'GET'), a.res);
    expect(a.statusCode()).toBe(405);
    for (const body of [
      { today: TODAY },
      { specs: [], today: TODAY },
      { specs: Array.from({ length: MAX_SPECS + 1 }, () => sessions), today: TODAY },
      { specs: [sessions], today: '15/09/2026' },
      { specs: [sessions] },
    ]) {
      const { res, statusCode } = makeRes();
      await handler(makeReq(body), res);
      expect(statusCode(), JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(loadAnalyticsInputs).not.toHaveBeenCalled();
  });
});

describe('POST /api/analytics-compute — results', () => {
  it('returns index-aligned results: a problem slot for a bad spec, computed data for a good one', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ specs: [{ version: 1, title: 'broken' }, sessions], today: TODAY }), res);
    expect(statusCode()).toBe(200);
    const { tiles } = body();
    expect(tiles).toHaveLength(2);
    expect(tiles[0].ok).toBe(false);
    expect((tiles[0] as { problem: string }).problem).toBeTruthy();
    expect(tiles[1].ok).toBe(true);
    const data = (tiles[1] as { ok: true; data: { series: Array<{ points: Array<number | null> }> } }).data;
    // Two completions inside the fixed September window; October is outside.
    expect(data.series[0].points).toEqual([2]);
    // The window fetched is the union of the valid specs, with the profile's HR settings.
    const [, userId, window, opts] = vi.mocked(loadAnalyticsInputs).mock.calls[0];
    expect(userId).toBe('user-123');
    expect(window).toMatchObject({ startDate: '2026-09-01', endDateExclusive: '2026-10-01' });
    expect(opts).toEqual({ withHrZones: false, hr: { maxHr: 190, thresholdHr: null } });
  });

  it('resolves the current-block preset against the active block, or reports the problem without one', async () => {
    const preset = makeSpec({ measure: 'session-count' }, { chartType: 'kpi', bucket: 'total', range: { kind: 'preset', preset: 'current-block' } });
    const none = makeRes();
    await handler(makeReq({ specs: [preset], today: TODAY }), none.res);
    expect(none.body().tiles[0]).toMatchObject({ ok: false, problem: expect.stringContaining('No active training block') });
    expect(loadAnalyticsInputs).not.toHaveBeenCalled();

    state.blocks = [{
      id: 'blk-1', user_id: 'user-123', name: 'Base', intent: '', phase: 'base', objective_id: null,
      start_date: '2026-09-07', end_date_exclusive: '2026-10-05', weekly_targets: {}, created_at: 'x', updated_at: 'x',
    }];
    const some = makeRes();
    await handler(makeReq({ specs: [preset], today: TODAY }), some.res);
    expect(some.body().tiles[0].ok).toBe(true);
    expect(vi.mocked(loadAnalyticsInputs).mock.calls.at(-1)![2]).toMatchObject({ startDate: '2026-09-07', endDateExclusive: '2026-10-05' });
  });
});
