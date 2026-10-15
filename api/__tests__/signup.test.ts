import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

let siteverify: ReturnType<typeof vi.fn>;
let state: State;

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = 'secret';
  state = { generateCalls: [], bumps: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
  mockedSend.mockClear();
  siteverify = vi.fn(async () => ({ json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', siteverify);
});

afterEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY;
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

  it('stops at the daily mail cap, counted across addresses', async () => {
    state.rows = [{ count: MAILS_PER_DAY - 3 }, { count: 3 }];
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(429);
    expect(state.generateCalls).toHaveLength(0);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('throttles repeat mails to one address without saying so', async () => {
    state.addressCount = MAILS_PER_ADDRESS + 1;
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    expect(mockedSend).not.toHaveBeenCalled();
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
