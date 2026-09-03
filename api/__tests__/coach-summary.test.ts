import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachSummary';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getAnthropicKey } from '../_lib/anthropicKey';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn(async () => 'sk-ant-test') }));
vi.mock('../_lib/trackerSession.js', () => ({
  loadResolvedOccurrence: vi.fn(async () => ({ id: 'evt-1', date: '2026-08-07', title: 'Bench', type: 'weights', exercises: [] })),
  buildFinishSummary: vi.fn(async () => ({ groups: [], prs: [], scoreRecord: null, recap: 'Workout: Bench' })),
}));

// The Anthropic SDK: a scripted stream of text deltas.
const deltas = ['Strong ', 'session.'];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream: () => (async function* () {
        for (const text of deltas) yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      })(),
      create: async () => ({ content: [{ type: 'text', text: 'One-shot.' }] }),
    };
  },
}));

interface State { session: Record<string, unknown> | null; updates: Record<string, unknown>[] }
let state: State;

function makeAdmin() {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: state.session, error: null }),
    update: (patch: Record<string, unknown>) => { state.updates.push(patch); return chain; },
  };
  return { from: () => chain } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown): VercelRequest {
  return { method: 'POST', headers: {}, query: {}, body } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const chunks: string[] = [];
  const listeners: Record<string, () => void> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
    write(chunk: string) { chunks.push(chunk); return true; },
    end() { return res; },
    on(event: string, fn: () => void) { listeners[event] = fn; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload, lines: () => chunks.join('').trim().split('\n').map(l => JSON.parse(l)) };
}

beforeEach(() => {
  state = { session: { finished_at: '2026-08-07T10:00:00Z', total_duration_seconds: 1800, score_type: null }, updates: [] };
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  vi.mocked(getAnthropicKey).mockResolvedValue('sk-ant-test');
});

describe('POST /api/coach-summary', () => {
  it('400s without eventId/eventDate or a legacy recap', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({}), res);
    expect(statusCode()).toBe(400);
  });

  it('402s without a saved key, before touching the session', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce(null);
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ eventId: 'evt-1', eventDate: '2026-08-07' }), res);
    expect(statusCode()).toBe(402);
    expect(body()).toBe('anthropic-key-missing');
  });

  it('409s for a session that is not finished', async () => {
    state.session = { finished_at: null };
    const { res, statusCode } = makeRes();
    await handler(makeReq({ eventId: 'evt-1', eventDate: '2026-08-07' }), res);
    expect(statusCode()).toBe(409);
  });

  it('streams the summary as NDJSON text events and persists the joined text', async () => {
    const { res, lines, statusCode } = makeRes();
    await handler(makeReq({ eventId: 'evt-1', eventDate: '2026-08-07' }), res);
    expect(statusCode()).toBeNull(); // streamed: no status() call, default 200
    expect(lines()).toEqual([
      { type: 'text', delta: 'Strong ' },
      { type: 'text', delta: 'session.' },
      { type: 'done' },
    ]);
    expect(state.updates).toEqual([expect.objectContaining({ coach_summary: 'Strong session.' })]);
  });

  it('keeps the legacy one-shot JSON contract for a client-built recap', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ recap: 'Workout: Bench' }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ text: 'One-shot.' });
    expect(state.updates).toEqual([]);
  });
});
