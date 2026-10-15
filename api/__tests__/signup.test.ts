import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { MAILS_PER_ADDRESS, MAILS_PER_DAY } from '../_lib/handlers/signup';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { sendAccountEmail } from '../_lib/mailer';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/mailer.js', () => ({ sendAccountEmail: vi.fn(async () => undefined) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedSend = vi.mocked(sendAccountEmail);

interface State {
  /** Today's signup_mail rows. */
  rows?: { count: number }[];
  /** What bump_rate_limit answers for this address. */
  addressCount?: number;
  bumpError?: { message: string } | null;
  linkError?: { code: string; message: string } | null;
  generateCalls: Record<string, unknown>[];
  bumps: Record<string, unknown>[];
  /** Users GoTrue's admin search returns for the address. */
  users?: { id: string; email: string; email_confirmed_at: string | null }[];
}

function makeAdmin(state: State) {
  return {
    from(table: string) {
      expect(table).toBe('api_request_counts');
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, val: string) => { expect([col, val]).toEqual(['bucket', 'signup_mail']); return builder; };
      builder.gte = async () => ({ data: state.rows ?? [], error: null });
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('bump_rate_limit');
      state.bumps.push(args);
      if (state.bumpError) return { data: null, error: state.bumpError };
      return { data: state.addressCount ?? 1, error: null };
    },
    auth: {
      admin: {
        generateLink: async (params: Record<string, unknown>) => {
          state.generateCalls.push(params);
          if (state.linkError) return { data: null, error: state.linkError };
          return {
            data: { user: { id: 'user-1' }, properties: { action_link: 'https://x.supabase.co/auth/v1/verify?token=t' } },
            error: null,
          };
        },
      },
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown, method = 'POST'): VercelRequest {
  return {
    method,
    body,
    headers: { host: 'apex.test', 'x-forwarded-for': '203.0.113.9' },
    query: {},
  } as unknown as VercelRequest;
}

function makeRes() {
  const res = { statusCode: 0, payload: undefined as unknown } as Record<string, unknown>;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (p: unknown) => { res.payload = p; return res; };
  res.send = (p: unknown) => { res.payload = p; return res; };
  res.setHeader = () => res;
  return res as unknown as VercelResponse & { statusCode: number; payload: unknown };
}

const GOOD = { email: 'New@Example.com ', captchaToken: 'tok' };

let siteverify: Mock<(url: string, init: RequestInit) => Promise<unknown>>;
let lookups: string[];
let state: State;

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = 'secret';
  process.env.VITE_SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  state = { generateCalls: [], bumps: [] };
  lookups = [];
  mockedAdmin.mockReturnValue(makeAdmin(state));
  mockedSend.mockClear();
  siteverify = vi.fn(async () => ({ json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/v1/admin/users')) {
      lookups.push(url);
      return { ok: true, json: async () => ({ users: state.users ?? [] }) };
    }
    return siteverify(url, init as RequestInit);
  }));
});

afterEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.unstubAllGlobals();
});

describe('/api/signup', () => {
  it('is closed (503) without a Turnstile secret, and creates nothing', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(503);
    expect(state.generateCalls).toHaveLength(0);
  });

  it('invites the address — no password — and mails the link', async () => {
    const res = makeRes();
    await handler(makeReq({ ...GOOD, password: 'chosen-by-whoever-asked-first' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    // An invite, so nobody holds a password until the mailbox owner clicks:
    // a password taken here would let the first caller squat the address.
    expect(state.generateCalls[0]).toMatchObject({ type: 'invite', email: 'new@example.com' });
    expect(state.generateCalls[0]).not.toHaveProperty('password');
    expect(state.bumps[0]).toEqual({ p_user_id: 'user-1', p_bucket: 'signup_mail', p_window_seconds: 86400 });
    expect(mockedSend).toHaveBeenCalledOnce();
    expect(mockedSend.mock.calls[0][0].to).toBe('new@example.com');
    expect(mockedSend.mock.calls[0][0].html).toContain('verify?token=t');
    // The secret, the token and the caller's IP reach Cloudflare.
    const form = siteverify.mock.calls[0][1].body as URLSearchParams;
    expect(form.get('secret')).toBe('secret');
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('203.0.113.9');
  });

  it('refuses a failed or missing human check before touching auth', async () => {
    siteverify.mockResolvedValueOnce({ json: async () => ({ success: false }) });
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(400);

    const res2 = makeRes();
    await handler(makeReq({ ...GOOD, captchaToken: '' }), res2);
    expect(res2.statusCode).toBe(400);
    expect(state.generateCalls).toHaveLength(0);
  });

  it('fails closed when siteverify is unreachable', async () => {
    siteverify.mockRejectedValueOnce(new Error('network'));
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(400);
    expect(state.generateCalls).toHaveLength(0);
  });

  it('validates the email before the human check', async () => {
    const res = makeRes();
    await handler(makeReq({ ...GOOD, email: 'not-an-email' }), res);
    expect(res.statusCode).toBe(400);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('counts an address for at most its own mail limit toward the day', async () => {
    // 49 attempts at one address sent 3 mails; a fresh address still gets in.
    state.rows = [{ count: 49 }];
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(mockedSend).toHaveBeenCalledOnce();
  });

  it('stops at the daily mail cap, counted across addresses', async () => {
    state.rows = Array.from({ length: Math.ceil(MAILS_PER_DAY / MAILS_PER_ADDRESS) }, () => ({ count: MAILS_PER_ADDRESS }));
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(429);
    expect(state.generateCalls).toHaveLength(0);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('throttles a pending address before generate_link, so the mailed link survives', async () => {
    state.users = [{ id: 'pending-1', email: 'new@example.com', email_confirmed_at: null }];
    state.addressCount = MAILS_PER_ADDRESS + 1;
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    // generate_link rotates a pending user's token: calling it here would
    // kill the link the owner already holds.
    expect(state.generateCalls).toHaveLength(0);
    expect(state.bumps[0]).toMatchObject({ p_user_id: 'pending-1' });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('re-invites a pending address under its limit', async () => {
    state.users = [{ id: 'pending-1', email: 'new@example.com', email_confirmed_at: null }];
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(state.bumps).toHaveLength(1);
    expect(mockedSend).toHaveBeenCalledOnce();
  });

  it('mails a confirmed account nothing and touches nothing', async () => {
    // A substring hit on another address must not be taken for this one.
    state.users = [
      { id: 'other', email: 'anew@example.com', email_confirmed_at: null },
      { id: 'mine', email: 'new@example.com', email_confirmed_at: '2026-10-01T00:00:00Z' },
    ];
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    expect(state.generateCalls).toHaveLength(0);
    expect(state.bumps).toHaveLength(0);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(lookups[0]).toContain('filter=new%40example.com');
  });

  it('fails closed when the mail counter cannot be bumped', async () => {
    state.bumpError = { message: 'db down' };
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(500);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('bounds the siteverify wait', async () => {
    // AbortSignal.timeout runs on Node's own timer, which fake timers do not
    // drive; that a signal is attached is what this pins (the abort itself
    // lands in the 'unreachable' branch above).
    await handler(makeReq(GOOD), makeRes());
    expect(siteverify.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('answers an existing address exactly like a new one, and mails nothing', async () => {
    state.linkError = { code: 'email_exists', message: 'A user with this email address has already been registered' };
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('is POST only', async () => {
    const res = makeRes();
    await handler(makeReq(GOOD, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });
});
