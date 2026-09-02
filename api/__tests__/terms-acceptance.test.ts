import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/termsAcceptance';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { requireUser } from '../_lib/auth';
import { clientIp, clientUserAgent } from '../_lib/legal';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/lib/legal/versions';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedRequireUser = vi.mocked(requireUser);

interface AdminState {
  /** The row .maybeSingle() resolves with on the read path. */
  latest?: Record<string, unknown> | null;
  /** Captured insert payload. */
  inserted?: Record<string, unknown>;
  /** Every insert seen, to prove the handler never updates. */
  inserts: Record<string, unknown>[];
  updateCalled?: boolean;
  deleteCalled?: boolean;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      expect(table).toBe('terms_acceptances');
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: state.latest ?? null, error: null });
      builder.single = async () => ({
        data: {
          terms_version: state.inserted?.terms_version,
          privacy_version: state.inserted?.privacy_version,
          accepted_at: '2026-08-29T10:00:00.000Z',
        },
        error: null,
      });
      builder.insert = (row: Record<string, unknown>) => {
        state.inserted = row;
        state.inserts.push(row);
        return builder;
      };
      // Present so a handler that reached for them would succeed loudly in
      // the assertions below rather than throwing an unrelated TypeError.
      builder.update = () => { state.updateCalled = true; return builder; };
      builder.delete = () => { state.deleteCalled = true; return builder; };
      return builder;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, opts: {
  body?: unknown;
  ip?: string;
  userAgent?: string;
} = {}): VercelRequest {
  const headers: Record<string, string> = {};
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.userAgent) headers['user-agent'] = opts.userAgent;
  return { method, headers, body: opts.body, query: {} } as unknown as VercelRequest;
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
  return { res, statusCode: () => code, body: () => payload as Record<string, unknown> };
}

let state: AdminState;

beforeEach(() => {
  state = { inserts: [] };
  mockedAdmin.mockReset();
  mockedAdmin.mockReturnValue(makeAdmin(state));
  mockedRequireUser.mockReset();
  mockedRequireUser.mockResolvedValue('user-123');
});

describe('POST /api/terms-acceptance', () => {
  it('records the acceptance and reports it current', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST'), res);
    expect(statusCode()).toBe(200);
    expect(body().current).toBe(true);
    expect(state.inserted).toMatchObject({
      user_id: 'user-123',
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
  });

  // The row is evidence. A client that could name the version it accepted
  // could claim to have agreed to a document that was never published.
  it('ignores versions supplied in the request body', async () => {
    const { res } = makeRes();
    await handler(makeReq('POST', {
      body: { terms_version: 'terms-v999', privacy_version: 'privacy-v999', user_id: 'someone-else' },
    }), res);
    expect(state.inserted!.terms_version).toBe(TERMS_VERSION);
    expect(state.inserted!.privacy_version).toBe(PRIVACY_VERSION);
    expect(state.inserted!.user_id).toBe('user-123');
  });

  it('stamps the user id from the verified JWT, never the body', async () => {
    mockedRequireUser.mockResolvedValue('verified-user');
    const { res } = makeRes();
    await handler(makeReq('POST', { body: { user_id: 'attacker' } }), res);
    expect(state.inserted!.user_id).toBe('verified-user');
  });

  it('captures IP and user agent as evidence', async () => {
    const { res } = makeRes();
    await handler(makeReq('POST', {
      ip: '203.0.113.7, 10.0.0.1',
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/141',
    }), res);
    expect(state.inserted!.ip).toBe('203.0.113.7');
    expect(state.inserted!.user_agent).toBe('Mozilla/5.0 (Macintosh) Chrome/141');
  });

  it('records a null IP rather than a placeholder when the header is absent', async () => {
    const { res } = makeRes();
    await handler(makeReq('POST'), res);
    expect(state.inserted!.ip).toBeNull();
    expect(state.inserted!.user_agent).toBeNull();
  });

  // Append-only is a property of the handler as well as the trigger: a second
  // acceptance must add a row, never touch the first.
  it('always inserts — it never updates or deletes an earlier row', async () => {
    const { res } = makeRes();
    await handler(makeReq('POST', { ip: '198.51.100.1' }), res);
    state.latest = {
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      accepted_at: '2026-08-29T10:00:00.000Z',
    };
    const second = makeRes();
    await handler(makeReq('POST', { ip: '198.51.100.2' }), second.res);
    expect(state.inserts).toHaveLength(2);
    expect(state.inserts.map(r => r.ip)).toEqual(['198.51.100.1', '198.51.100.2']);
    expect(state.updateCalled).toBeUndefined();
    expect(state.deleteCalled).toBeUndefined();
  });

  it('is exempt from the terms gate — accepting is how a blocked user unblocks', async () => {
    const { res } = makeRes();
    await handler(makeReq('POST'), res);
    expect(mockedRequireUser).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { skipTermsGate: true },
    );
  });

  it('does nothing when the caller is unauthenticated', async () => {
    mockedRequireUser.mockResolvedValue(null);
    const { res } = makeRes();
    await handler(makeReq('POST'), res);
    expect(state.inserts).toHaveLength(0);
  });
});

describe('GET /api/terms-acceptance', () => {
  it('reports no acceptance, and the versions on offer', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({
      accepted: null,
      current: false,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });
  });

  // What drives the modal's "our terms have changed" copy, rather than
  // "before you start".
  it('reports a stale acceptance as not current, naming the old versions', async () => {
    state.latest = {
      terms_version: 'terms-v0',
      privacy_version: 'privacy-v0',
      accepted_at: '2026-01-01T00:00:00.000Z',
    };
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(body().current).toBe(false);
    expect(body().accepted).toEqual({
      termsVersion: 'terms-v0',
      privacyVersion: 'privacy-v0',
      acceptedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports a matching acceptance as current', async () => {
    state.latest = {
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      accepted_at: '2026-08-29T10:00:00.000Z',
    };
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(body().current).toBe(true);
  });
});

describe('method handling', () => {
  it('405s anything but GET and POST', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const { res, statusCode } = makeRes();
      await handler(makeReq(method), res);
      expect(statusCode(), `${method} must not be routed`).toBe(405);
    }
  });
});

// Evidence fields, isolated from the handler. x-forwarded-for is a chain and
// the ORIGINAL client is the FIRST entry — taking the last records a proxy,
// which is worse than useless in a dispute.
describe('clientIp / clientUserAgent', () => {
  it('takes the first hop of an x-forwarded-for chain', () => {
    expect(clientIp(makeReq('POST', { ip: '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe('203.0.113.7');
  });

  it('handles a single-entry header', () => {
    expect(clientIp(makeReq('POST', { ip: '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('is null when the header is missing or empty', () => {
    expect(clientIp(makeReq('POST'))).toBeNull();
    expect(clientIp(makeReq('POST', { ip: '   ' }))).toBeNull();
  });

  it('bounds the user agent — evidence, not a free text field', () => {
    const ua = clientUserAgent(makeReq('POST', { userAgent: 'x'.repeat(900) }));
    expect(ua).toHaveLength(500);
  });
});
