import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { TERMS_REQUIRED_BODY } from '../_lib/legal';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/lib/legal/versions';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));

const getUser = vi.fn();
const mockedAdmin = vi.mocked(getSupabaseAdmin);

function makeReq(authorization?: string): VercelRequest {
  return { headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}

interface CapturedResponse {
  res: VercelResponse;
  statusCode: () => number | null;
  body: () => unknown;
}

function makeRes(): CapturedResponse {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

// requireUser now also asks the terms ledger whether this user has accepted
// the current documents, so every admin fake needs a terms_acceptances
// query shape: .select().eq().order().limit().maybeSingle().
function makeAdmin(acceptance: unknown, opts: { error?: string } = {}) {
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) builder[m] = () => builder;
    builder.maybeSingle = async () => ({
      data: opts.error ? null : acceptance,
      error: opts.error ? { message: opts.error } : null,
    });
    return builder;
  });
  return { auth: { getUser }, from } as unknown as ReturnType<typeof getSupabaseAdmin>;
}

const CURRENT_ROW = {
  terms_version: TERMS_VERSION,
  privacy_version: PRIVACY_VERSION,
  accepted_at: '2026-08-29T00:00:00.000Z',
};

beforeEach(() => {
  getUser.mockReset();
  mockedAdmin.mockReset();
  mockedAdmin.mockReturnValue(makeAdmin(CURRENT_ROW));
});

describe('requireUser', () => {
  it('500s when the admin client is not configured', async () => {
    mockedAdmin.mockReturnValue(null);
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer tok'), res)).toBeNull();
    expect(statusCode()).toBe(500);
  });

  it('401s with no Authorization header', async () => {
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq(), res)).toBeNull();
    expect(statusCode()).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('401s on a non-Bearer Authorization header', async () => {
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Basic abc123'), res)).toBeNull();
    expect(statusCode()).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('401s when the token does not validate', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer expired'), res)).toBeNull();
    expect(statusCode()).toBe(401);
    expect(getUser).toHaveBeenCalledWith('expired');
  });

  it('returns the verified user id and sends nothing on success', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res)).toBe('user-123');
    expect(statusCode()).toBeNull();
    expect(getUser).toHaveBeenCalledWith('good-token');
  });
});

// The clickwrap's actual enforcement. A checkbox in the browser is a
// courtesy; these are the tests that matter if the agreement is ever
// disputed, because they are what stops an unaccepted account from using
// the service at all.
describe('requireUser — terms gate', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
  });

  it('403s terms-acceptance-required when the user has never accepted', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(null));
    const { res, statusCode, body } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res)).toBeNull();
    expect(statusCode()).toBe(403);
    expect(body()).toBe(TERMS_REQUIRED_BODY);
  });

  it('403s when the stored acceptance names an older terms version', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ ...CURRENT_ROW, terms_version: 'terms-v0' }));
    const { res, statusCode, body } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res)).toBeNull();
    expect(statusCode()).toBe(403);
    expect(body()).toBe(TERMS_REQUIRED_BODY);
  });

  it('403s when only the privacy version is behind', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ ...CURRENT_ROW, privacy_version: 'privacy-v0' }));
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res)).toBeNull();
    expect(statusCode()).toBe(403);
  });

  it('passes when both versions are current', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(CURRENT_ROW));
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res)).toBe('user-123');
    expect(statusCode()).toBeNull();
  });

  // Unlike the rate limiter, which fails OPEN so a database hiccup cannot
  // take the app down, the consent gate fails CLOSED — otherwise an induced
  // error is a bypass.
  it('fails closed when the acceptance lookup errors', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(null, { error: 'connection reset' }));
    const { res, statusCode, body } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res)).toBeNull();
    expect(statusCode()).toBe(403);
    expect(body()).toBe(TERMS_REQUIRED_BODY);
  });

  it('skipTermsGate lets the exempt endpoints through unaccepted', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(null));
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer good-token'), res, { skipTermsGate: true }))
      .toBe('user-123');
    expect(statusCode()).toBeNull();
  });

  it('still 401s an invalid token before it ever reaches the gate', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } });
    mockedAdmin.mockReturnValue(makeAdmin(null));
    const { res, statusCode } = makeRes();
    expect(await requireUser(makeReq('Bearer nope'), res)).toBeNull();
    expect(statusCode()).toBe(401);
  });
});
