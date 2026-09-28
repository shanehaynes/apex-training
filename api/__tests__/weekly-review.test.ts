import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/weeklyReview';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { requireUser } from '../_lib/auth';
import { enforceRateLimit } from '../_lib/rateLimit';
import { getAnthropicKey } from '../_lib/anthropicKey';
import { fetchWeeklyInputs, generateWeeklyDocument } from '../_lib/review/weekly';

// The handler around the weekly review: method, body, auth, throttle, key,
// then the generation seam. The generation itself is covered by
// weekly-review-build.test.ts; here it is scripted so the HTTP contract is
// what is under test — which status each failure earns, and that no read
// happens before the gate that should stop it.

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn(async () => 'sk-ant-test') }));
vi.mock('../_lib/anthropicClient.js', () => ({ makeAnthropicClient: vi.fn(() => ({ tag: 'client' })) }));
vi.mock('../_lib/review/weekly.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../_lib/review/weekly')>();
  return { ...actual, fetchWeeklyInputs: vi.fn(), generateWeeklyDocument: vi.fn() };
});

const DOCUMENT = {
  week: { start: '2026-09-21', end: '2026-09-27' },
  planVsDone: { planned: 3, completed: 2, minutesPlanned: 285, minutesDone: 242, misses: [] },
  physiology: { summary: 'Steady.', flags: [] },
  doctrine: null,
  memoryProposals: [],
  nextWeek: [],
  headline: 'A steady week.',
};

let profile: Record<string, unknown> | null;

function makeAdmin() {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: profile, error: null }),
  };
  return { from: () => chain } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown, query: Record<string, string> = {}): VercelRequest {
  return { method, headers: {}, query, body } as unknown as VercelRequest;
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
  return { res, statusCode: () => code, body: () => payload };
}

const POST = (body: unknown, query?: Record<string, string>) => makeReq('POST', body, query);

beforeEach(() => {
  profile = { coach_goal: 'Rainier', coach_context: null, coach_model: 'claude-sonnet-5' };
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  vi.mocked(requireUser).mockResolvedValue('user-123');
  vi.mocked(enforceRateLimit).mockClear();
  vi.mocked(enforceRateLimit).mockResolvedValue(true);
  vi.mocked(getAnthropicKey).mockResolvedValue('sk-ant-test');
  vi.mocked(fetchWeeklyInputs).mockClear();
  vi.mocked(fetchWeeklyInputs).mockResolvedValue({ physiology: '' } as never);
  vi.mocked(generateWeeklyDocument).mockClear();
  vi.mocked(generateWeeklyDocument).mockResolvedValue({ ok: true, document: DOCUMENT, warnings: ['one warning'] } as never);
});

describe('POST /api/weekly-review', () => {
  it('405s GET: nothing is stored, so there is nothing to fetch', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(405);
    expect(requireUser).not.toHaveBeenCalled();
  });

  it('400s a missing or malformed today, and a malformed week, before auth', async () => {
    for (const body of [{}, { today: '09/21/2026' }, { today: '2026-09-21', week: 'last' }]) {
      const { res, statusCode } = makeRes();
      await handler(POST(body), res);
      expect(statusCode(), JSON.stringify(body)).toBe(400);
    }
    expect(requireUser).not.toHaveBeenCalled();
  });

  it('stops at auth and at the writes throttle without reading anything', async () => {
    vi.mocked(requireUser).mockResolvedValueOnce(null as never);
    await handler(POST({ today: '2026-09-28' }), makeRes().res);
    expect(getAnthropicKey).not.toHaveBeenCalled();

    vi.mocked(enforceRateLimit).mockResolvedValueOnce(false);
    await handler(POST({ today: '2026-09-28' }), makeRes().res);
    expect(enforceRateLimit).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'user-123', 'writes');
    expect(getAnthropicKey).not.toHaveBeenCalled();
    expect(fetchWeeklyInputs).not.toHaveBeenCalled();
  });

  it('402s without a saved key, 500s when the key cannot be read — both before gathering the week', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce(null);
    const a = makeRes();
    await handler(POST({ today: '2026-09-28' }), a.res);
    expect(a.statusCode()).toBe(402);
    expect(a.body()).toBe('anthropic-key-missing');

    vi.mocked(getAnthropicKey).mockRejectedValueOnce(new Error('rotated secret'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = makeRes();
    await handler(POST({ today: '2026-09-28' }), b.res);
    err.mockRestore();
    expect(b.statusCode()).toBe(500);
    expect(fetchWeeklyInputs).not.toHaveBeenCalled();
  });

  it('gathers the week for this user, on the profile\'s model, and answers the document envelope', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(POST({ today: '2026-09-28' }), res);
    expect(statusCode()).toBe(200);
    expect(fetchWeeklyInputs).toHaveBeenCalledWith(
      expect.anything(), 'user-123', '2026-09-28', { start: '2026-09-28', end: '2026-10-04' }, { goal: 'Rainier', context: undefined },
    );
    expect(generateWeeklyDocument).toHaveBeenCalledWith(
      { tag: 'client' }, expect.objectContaining({ id: 'claude-sonnet-5' }), { physiology: '' },
    );
    expect(body()).toEqual({
      document: DOCUMENT,
      model: { id: 'claude-sonnet-5', label: 'Sonnet 5', badge: 'claude sonnet 5' },
      warnings: ['one warning'],
      generatedAt: expect.any(String),
    });
  });

  it('takes the week from the body or the query, and falls back to the default model without a profile', async () => {
    profile = null;
    await handler(POST({ today: '2026-09-28', week: '2026-09-23' }), makeRes().res);
    expect(fetchWeeklyInputs).toHaveBeenLastCalledWith(expect.anything(), 'user-123', '2026-09-28', { start: '2026-09-21', end: '2026-09-27' }, { goal: undefined, context: undefined });
    await handler(POST({ today: '2026-09-28' }, { week: '2026-09-16' }), makeRes().res);
    expect(fetchWeeklyInputs).toHaveBeenLastCalledWith(expect.anything(), 'user-123', '2026-09-28', { start: '2026-09-14', end: '2026-09-20' }, expect.anything());
    expect(generateWeeklyDocument).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ id: 'claude-opus-5-5' }), expect.anything());
  });

  it('422s with the parse error when the model never returned a document, 500s on any other failure', async () => {
    vi.mocked(generateWeeklyDocument).mockResolvedValueOnce({ ok: false, parseError: 'not valid JSON: Unexpected token' });
    const a = makeRes();
    await handler(POST({ today: '2026-09-28' }), a.res);
    expect(a.statusCode()).toBe(422);
    expect(a.body()).toBe('The coach did not return a review document: not valid JSON: Unexpected token');

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(generateWeeklyDocument).mockRejectedValueOnce(new Error('overloaded'));
    const b = makeRes();
    await handler(POST({ today: '2026-09-28' }), b.res);
    expect(b.statusCode()).toBe(500);
    expect(b.body()).toBe('Weekly review generation failed');

    vi.mocked(fetchWeeklyInputs).mockRejectedValueOnce(new Error('workout_events fetch failed'));
    const c = makeRes();
    await handler(POST({ today: '2026-09-28' }), c.res);
    expect(c.statusCode()).toBe(500);
    expect(c.body()).toBe('Failed to gather the week');
    err.mockRestore();
  });
});
