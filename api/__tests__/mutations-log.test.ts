import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/mutationsLog';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  event_mutations_log: [
    { operation: 'create', event_title: 'Push day', event_date: '2026-09-09', triggered_by: 'ai', logged_at: '2026-09-09T10:00:00Z' },
  ],
  definition_mutations_log: [
    { operation: 'update', definition_name: 'Press', triggered_by: 'user', logged_at: '2026-09-08T10:00:00Z' },
  ],
  block_mutations_log: [
    { operation: 'create', resource: 'objective', resource_name: 'Spring', triggered_by: 'user', logged_at: '2026-09-07T10:00:00Z' },
  ],
};

/** Tables the handler actually read, in the order it asked for them. */
let touched: string[] = [];

function makeAdmin() {
  return {
    from(table: string) {
      touched.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) b[m] = () => b;
      b.limit = () => ({
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: ROWS[table] ?? [], error: null }).then(resolve),
      });
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method = 'GET'): VercelRequest {
  return { method, headers: {}, query: {} } as unknown as VercelRequest;
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

beforeEach(() => {
  touched = [];
  mockedAdmin.mockReturnValue(makeAdmin());
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
});

describe('GET /api/mutations-log', () => {
  it('charges the reads bucket and merges the three logs newest-first', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(mockedLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
    expect(statusCode()).toBe(200);
    const { entries } = body() as { entries: Array<{ source: string }> };
    expect(entries.map(e => e.source)).toEqual(['event', 'definition', 'objective']);
  });

  it('reads nothing when the caller is over the limit', async () => {
    mockedLimit.mockResolvedValue(false);
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(touched).toEqual([]);
  });
});
