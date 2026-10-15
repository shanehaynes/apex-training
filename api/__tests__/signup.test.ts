import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { MAX_SIGNUPS_PER_DAY } from '../_lib/handlers/signup';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { sendAccountEmail } from '../_lib/mailer';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/mailer.js', () => ({ sendAccountEmail: vi.fn(async () => undefined) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedSend = vi.mocked(sendAccountEmail);

interface State {
  count?: number;
  linkError?: { code: string; message: string } | null;
  generateCalls: Record<string, unknown>[];
}

function makeAdmin(state: State) {
  return {
    from(table: string) {
      expect(table).toBe('profiles');
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.gte = async () => ({ count: state.count ?? 0, error: null });
      return builder;
    },
    auth: {
      admin: {
        generateLink: async (params: Record<string, unknown>) => {
          state.generateCalls.push(params);
          if (state.linkError) return { data: null, error: state.linkError };
          return { data: { properties: { action_link: 'https://x.supabase.co/auth/v1/verify?token=t' } }, error: null };
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

const GOOD = { email: 'New@Example.com ', password: 'a-long-password', captchaToken: 'tok' };

let siteverify: ReturnType<typeof vi.fn>;
let state: State;

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = 'secret';
  state = { generateCalls: [] };
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

  it('creates an unconfirmed user and mails the confirmation link', async () => {
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    expect(state.generateCalls[0]).toMatchObject({ type: 'signup', email: 'new@example.com', password: 'a-long-password' });
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

  it('validates email and password length', async () => {
    const res = makeRes();
    await handler(makeReq({ ...GOOD, email: 'not-an-email' }), res);
    expect(res.statusCode).toBe(400);
    const res2 = makeRes();
    await handler(makeReq({ ...GOOD, password: 'short' }), res2);
    expect(res2.statusCode).toBe(400);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('stops at the daily cap', async () => {
    state.count = MAX_SIGNUPS_PER_DAY;
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(429);
    expect(state.generateCalls).toHaveLength(0);
  });

  it('answers an existing address exactly like a new one, and mails nothing', async () => {
    state.linkError = { code: 'email_exists', message: 'A user with this email address has already been registered' };
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ status: 'pending' });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("passes GoTrue's weak-password message through", async () => {
    state.linkError = { code: 'weak_password', message: 'Password is known to be weak' };
    const res = makeRes();
    await handler(makeReq(GOOD), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ error: 'Password is known to be weak' });
  });

  it('is POST only', async () => {
    const res = makeRes();
    await handler(makeReq(GOOD, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });
});
