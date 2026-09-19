import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/templateCopy';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
// The source account is normally resolved from the env; pinning it here keeps
// the fake admin down to the tables the copy itself touches.
vi.mock('../_lib/env.js', () => ({ optionalEnv: vi.fn(() => 'source-1') }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);

interface AdminState {
  /** Rows the lock UPDATE reports as claimed — [] means somebody else holds it. */
  lockRows: Array<{ id: string }>;
  /** What the readback sees on the profile when the claim loses. */
  copiedAt: string | null;
  /** No profiles row at all — the other reason the lock UPDATE matches nothing. */
  profileMissing?: boolean;
  sourceEvents: Array<Record<string, unknown>>;
  /** Recorded: every profiles UPDATE payload, in order. */
  profileUpdates: Array<Record<string, unknown>>;
  insertedEvents: number;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
      const settle = (): { data: unknown; error: null } => {
        if (table === 'profiles') {
          if (op === 'update') return { data: state.lockRows, error: null };
          return { data: state.profileMissing ? null : { template_copied_at: state.copiedAt }, error: null };
        }
        if (table === 'workout_events') {
          if (op === 'insert') return { data: null, error: null };
          return { data: state.sourceEvents, error: null };
        }
        return { data: [], error: null };
      };
      for (const m of ['eq', 'is', 'in', 'or', 'limit', 'order']) b[m] = () => b;
      b.select = () => b;
      b.update = (row: Record<string, unknown>) => {
        op = 'update';
        if (table === 'profiles') state.profileUpdates.push(row);
        return b;
      };
      b.insert = (rows: unknown[]) => {
        op = 'insert';
        if (table === 'workout_events') state.insertedEvents += rows.length;
        return b;
      };
      b.upsert = () => { op = 'upsert'; return b; };
      b.maybeSingle = async () => settle();
      b.single = async () => settle();
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(): VercelRequest {
  return { method: 'POST', headers: {}, body: {}, query: {} } as unknown as VercelRequest;
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

let state: AdminState;

beforeEach(() => {
  state = { lockRows: [{ id: 'user-123' }], copiedAt: null, sourceEvents: [], profileUpdates: [], insertedEvents: 0 };
  mockedAdmin.mockReturnValue(makeAdmin(state));
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
});

describe('POST /api/template-copy — throttle', () => {
  it('charges the reads bucket', async () => {
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(mockedLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
  });

  it('never claims the lock when the caller is over the limit', async () => {
    mockedLimit.mockResolvedValue(false);
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(state.profileUpdates).toEqual([]);
  });
});

describe('POST /api/template-copy — a lost claim', () => {
  it('copies when it wins the claim', async () => {
    state.sourceEvents = [{ id: 'src-1', user_id: 'source-1', title: 'Push day' }];
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ events: 1, definitions: 0 });
    expect(state.insertedEvents).toBe(1);
  });

  // The claim is stamped BEFORE the inserts, so a racing caller that loses it
  // cannot conclude the plan is on the calendar — it gets the stamp instead
  // and decides for itself (a fresh one means a copy still in flight).
  it('answers with the stamp it lost to, not a bare alreadyCopied', async () => {
    state.lockRows = [];
    state.copiedAt = '2026-09-19T12:00:00Z';
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ alreadyCopied: true, copiedAt: '2026-09-19T12:00:00Z' });
    expect(state.insertedEvents).toBe(0);
  });

  // A copy that failed releases the claim, so a caller can lose the race and
  // still find nothing copied. A null stamp is how it learns that.
  it('reports a null stamp when the claim was released underneath it', async () => {
    state.lockRows = [];
    state.copiedAt = null;
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ alreadyCopied: true, copiedAt: null });
  });

  it('404s when there is no profile row to claim', async () => {
    state.lockRows = [];
    state.profileMissing = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(404);
  });
});
