import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/providerCron';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { listAutoSyncConnections } from '../_lib/providers/connection';
import { runAutoSync } from '../_lib/providers/sync';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/providers/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/providers/connection.js')>()),
  listAutoSyncConnections: vi.fn(),
}));
vi.mock('../_lib/providers/sync.js', () => ({ runAutoSync: vi.fn() }));

const mockedList = vi.mocked(listAutoSyncConnections);
const mockedRun = vi.mocked(runAutoSync);

function makeReq(query: Record<string, string> = {}, auth?: string): VercelRequest {
  return {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
    query,
  } as unknown as VercelRequest;
}

function makeRes() {
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
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-test-secret';
  vi.mocked(getSupabaseAdmin).mockReturnValue({} as never);
});

describe('provider-cron handler', () => {
  it('401s without the cron secret', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({}, 'Bearer wrong'), res);
    expect(statusCode()).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('401s when CRON_SECRET is unset (never fail-open)', async () => {
    delete process.env.CRON_SECRET;
    const { res, statusCode } = makeRes();
    await handler(makeReq({}, 'Bearer undefined'), res);
    expect(statusCode()).toBe(401);
  });

  it('dry run lists who would sync without running anything', async () => {
    mockedList.mockResolvedValue([
      { user_id: 'u1', provider: 'coros', timezone: 'America/New_York' },
    ]);
    const { res, body } = makeRes();
    await handler(makeReq({ dryRun: '1' }, 'Bearer cron-test-secret'), res);
    expect(body()).toEqual({
      dryRun: true,
      wouldSync: [{ provider: 'coros', timezone: 'America/New_York' }],
      deferred: 0,
    });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('syncs each connected coros user with their stored timezone, UTC fallback', async () => {
    mockedList.mockResolvedValue([
      { user_id: 'u1', provider: 'coros', timezone: 'America/New_York' },
      { user_id: 'u2', provider: 'coros', timezone: null },
    ]);
    mockedRun.mockResolvedValue({ created: 2, pendingFills: 1, errors: 0 });
    const { res, body } = makeRes();
    await handler(makeReq({}, 'Bearer cron-test-secret'), res);
    expect(mockedRun).toHaveBeenCalledWith({}, 'u1', 'coros', 'America/New_York');
    expect(mockedRun).toHaveBeenCalledWith({}, 'u2', 'coros', 'UTC');
    expect(body()).toMatchObject({ connections: 2, created: 4, pendingFills: 2, failures: 0 });
  });

  it('skips unimplemented providers and isolates per-user failures', async () => {
    mockedList.mockResolvedValue([
      { user_id: 'u1', provider: 'garmin' as never, timezone: null },
      { user_id: 'u2', provider: 'coros', timezone: null },
      { user_id: 'u3', provider: 'coros', timezone: null },
    ]);
    mockedRun
      .mockRejectedValueOnce(new Error('token exchange exploded'))
      .mockResolvedValueOnce({ created: 1, pendingFills: 0, errors: 0 });
    const { res, body } = makeRes();
    await handler(makeReq({}, 'Bearer cron-test-secret'), res);
    // garmin skipped, u2 failed, u3 still ran.
    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect(body()).toMatchObject({ connections: 3, created: 1, failures: 2 });
  });

  it('?userId= narrows the run to one user', async () => {
    mockedList.mockResolvedValue([
      { user_id: 'u1', provider: 'coros', timezone: null },
      { user_id: 'u2', provider: 'coros', timezone: null },
    ]);
    mockedRun.mockResolvedValue({ created: 0, pendingFills: 0, errors: 0 });
    const { res } = makeRes();
    await handler(makeReq({ userId: 'u2' }, 'Bearer cron-test-secret'), res);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun).toHaveBeenCalledWith({}, 'u2', 'coros', 'UTC');
  });
});
