import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelResponse } from '@vercel/node';
import { enforceRateLimit, enforceAiMutationCap } from '../_lib/rateLimit';
import { sendReviewEmail } from '../_lib/mailer';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/mailer.js', () => ({ sendReviewEmail: vi.fn(async () => {}) }));

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload, headers };
}

function makeAdmin(state: {
  rpcCount?: number | Error;
  logCounts?: { events: number; definitions: number; meals?: number } | Error;
  email?: string | null;
}): Admin {
  return {
    rpc: vi.fn(async () => {
      if (state.rpcCount instanceof Error) return { data: null, error: { message: state.rpcCount.message } };
      return { data: state.rpcCount ?? 1, error: null };
    }),
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: async () => {
              if (state.logCounts instanceof Error) return { count: null, error: { message: state.logCounts.message } };
              const count = table === 'event_mutations_log'
                ? state.logCounts?.events ?? 0
                : table === 'meal_mutations_log'
                ? state.logCounts?.meals ?? 0
                : state.logCounts?.definitions ?? 0;
              return { count, error: null };
            },
          }),
        }),
      }),
    }),
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({ data: { user: { email: state.email ?? 'a@b.c' } }, error: null })),
      },
    },
  } as unknown as Admin;
}

beforeEach(() => {
  vi.mocked(sendReviewEmail).mockClear();
});

describe('enforceRateLimit', () => {
  it('allows requests under the bucket limit', async () => {
    const { res, statusCode } = makeRes();
    const ok = await enforceRateLimit(makeAdmin({ rpcCount: 5 }), res, 'u1', 'chat');
    expect(ok).toBe(true);
    expect(statusCode()).toBeNull();
  });

  it('429s with Retry-After when over the limit', async () => {
    const { res, statusCode, headers } = makeRes();
    const ok = await enforceRateLimit(makeAdmin({ rpcCount: 31 }), res, 'u1', 'chat');
    expect(ok).toBe(false);
    expect(statusCode()).toBe(429);
    expect(headers['Retry-After']).toBe('600');
  });

  it('fails open when the RPC errors', async () => {
    const { res, statusCode } = makeRes();
    const ok = await enforceRateLimit(makeAdmin({ rpcCount: new Error('no such function') }), res, 'u1', 'writes');
    expect(ok).toBe(true);
    expect(statusCode()).toBeNull();
  });
});

describe('enforceAiMutationCap', () => {
  it('allows when under the cap', async () => {
    const { res, statusCode } = makeRes();
    const ok = await enforceAiMutationCap(makeAdmin({ logCounts: { events: 10, definitions: 5 } }), res, 'u1', 200);
    expect(ok).toBe(true);
    expect(statusCode()).toBeNull();
    expect(sendReviewEmail).not.toHaveBeenCalled();
  });

  it('counts meal mutations toward the cap', async () => {
    const { res, statusCode } = makeRes();
    // 100 + 50 + 50 = 200 — at the cap only because meals count.
    const ok = await enforceAiMutationCap(makeAdmin({ logCounts: { events: 100, definitions: 50, meals: 50 } }), res, 'u1', 200);
    expect(ok).toBe(false);
    expect(statusCode()).toBe(429);
  });

  it('429s and emails exactly once at the first breach', async () => {
    const admin = makeAdmin({ logCounts: { events: 150, definitions: 50 }, email: 'shane@example.com' });
    const { res, statusCode } = makeRes();
    const ok = await enforceAiMutationCap(admin, res, 'u1', 200);
    expect(ok).toBe(false);
    expect(statusCode()).toBe(429);
    expect(sendReviewEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendReviewEmail).mock.calls[0][0].to).toBe('shane@example.com');
  });

  it('429s without re-emailing once past the cap', async () => {
    const { res, statusCode } = makeRes();
    const ok = await enforceAiMutationCap(makeAdmin({ logCounts: { events: 201, definitions: 0 } }), res, 'u1', 200);
    expect(ok).toBe(false);
    expect(statusCode()).toBe(429);
    expect(sendReviewEmail).not.toHaveBeenCalled();
  });

  it('fails open when the log count errors', async () => {
    const { res, statusCode } = makeRes();
    const ok = await enforceAiMutationCap(makeAdmin({ logCounts: new Error('boom') }), res, 'u1', 200);
    expect(ok).toBe(true);
    expect(statusCode()).toBeNull();
  });

  it('still blocks when the alert email fails', async () => {
    vi.mocked(sendReviewEmail).mockRejectedValueOnce(new Error('smtp down'));
    const { res, statusCode } = makeRes();
    const ok = await enforceAiMutationCap(makeAdmin({ logCounts: { events: 200, definitions: 0 } }), res, 'u1', 200);
    expect(ok).toBe(false);
    expect(statusCode()).toBe(429);
  });
});
