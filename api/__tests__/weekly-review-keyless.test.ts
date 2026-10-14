import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/weeklyReview';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getAnthropicKey } from '../_lib/anthropicKey';
import { fetchWeeklyInputs, generateWeeklyDocument } from '../_lib/review/weekly';
import { isWeeklyReviewResponse, type WeeklyReviewStats } from '../../src/lib/review/weekly';

// POST /api/weekly-review with and without a key: the computed stats ride
// every 200, the document only when a key let the model run. The answer
// must pass the client's own guard in both shapes.

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn() }));
vi.mock('../_lib/anthropicClient.js', () => ({ makeAnthropicClient: vi.fn(() => ({ tag: 'client' })) }));
vi.mock('../_lib/review/weekly.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../_lib/review/weekly')>();
  return { ...actual, fetchWeeklyInputs: vi.fn(), generateWeeklyDocument: vi.fn() };
});

const WEEK = { start: '2026-09-21', end: '2026-09-27' };
const PLAN = { planned: 3, completed: 2, minutesPlanned: 285, minutesDone: 242, misses: [] };
const STATS: WeeklyReviewStats = {
  week: WEEK,
  asOf: WEEK.end,
  plan: PLAN,
  prs: [{ exerciseName: 'Squat', kind: 'reps', date: '2026-09-22', detail: '12 reps, up from 10 on Sep 1' }],
  weightUnit: 'lb',
  physiology: {
    load: { source: 'trainingLoad', acute7d: 200, chronicWeeklyAvg28d: 50, ratio: 4 },
    hrv: { mean7d: null, mean28d: 61 },
    zoneMinutes: [10, 20, 0, 0, 0],
    zoneMethod: 'device',
    tonnageByWeek: [{ weekStart: WEEK.start, tonnageLb: 1000 }],
  },
};
const DOCUMENT = {
  week: WEEK, planVsDone: PLAN, physiology: { summary: 'Steady.', flags: [] },
  doctrine: null, memoryProposals: [], nextWeek: [], headline: 'A steady week.',
};

function makeAdmin() {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
  return { from: () => chain } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function call(body: unknown) {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  const req = { method: 'POST', headers: {}, query: {}, body } as unknown as VercelRequest;
  return handler(req, res).then(() => ({ status: code, body: payload }));
}

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  vi.mocked(fetchWeeklyInputs).mockReset();
  vi.mocked(fetchWeeklyInputs).mockResolvedValue({ physiology: '', weeklyStats: STATS } as never);
  vi.mocked(generateWeeklyDocument).mockReset();
  vi.mocked(generateWeeklyDocument).mockResolvedValue({ ok: true, document: DOCUMENT, warnings: [] } as never);
});

describe('POST /api/weekly-review without and with a key', () => {
  it('without a key: 200, no document, no model, the stats — and no model call', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValue(null);
    const { status, body } = await call({ today: '2026-10-14', week: '2026-09-23' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ document: null, model: null, stats: STATS, warnings: [] });
    expect(isWeeklyReviewResponse(body)).toBe(true);
    expect(fetchWeeklyInputs).toHaveBeenCalledWith(expect.anything(), 'user-123', '2026-10-14', WEEK, expect.anything());
    expect(generateWeeklyDocument).not.toHaveBeenCalled();
  });

  it('with a key: the document and the same stats', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValue('sk-ant-test');
    const { status, body } = await call({ today: '2026-10-14', week: '2026-09-23' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ document: DOCUMENT, stats: STATS });
    expect((body as { model: { id: string } }).model.id).toBeTruthy();
    expect(isWeeklyReviewResponse(body)).toBe(true);
    expect(generateWeeklyDocument).toHaveBeenCalledTimes(1);
  });
});
