import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

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

beforeEach(() => {
  getUser.mockReset();
  mockedAdmin.mockReset();
  mockedAdmin.mockReturnValue({ auth: { getUser } } as unknown as ReturnType<typeof getSupabaseAdmin>);
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
