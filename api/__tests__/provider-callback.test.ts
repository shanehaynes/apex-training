import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/providerCallback';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { exchangeCode } from '../_lib/providers/coros/oauth';

// The OAuth callback had no test of any kind before W11. It is the one route
// with no JWT — identity comes entirely from the `state` on the pending row —
// and W11 makes it branch on which client started the dance, so the web's two
// redirect strings are now something a test has to pin rather than something
// nobody was allowed to touch.

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/providers/coros/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/providers/coros/oauth.js')>()),
  exchangeCode: vi.fn(async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedExchange = vi.mocked(exchangeCode);

const WEB_OK = '/?connected=coros';
const WEB_FAIL = '/?connect_error=coros';

interface Row { [k: string]: unknown }

/** Stands in for the two calls the handler makes: findPendingByState's
 *  select/eq/eq/maybeSingle, and completeOAuth's update/eq/eq. */
function makeAdmin(row: Row | null, onUpdate?: (patch: Row) => void) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: row, error: null }),
    update: (patch: Row) => { onUpdate?.(patch); return builder; },
  });
  return { from: () => builder } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(query: Record<string, string>, method = 'GET'): VercelRequest {
  return { method, headers: {}, query, body: undefined } as unknown as VercelRequest;
}

/** Unlike the provider-sync harness, this one keeps redirect's arguments —
 *  they are the entire contract under test. */
function makeRes() {
  let code: number | null = null;
  let location: string | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
    redirect(status: number, url: string) { code = status; location = url; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, location: () => location, body: () => payload };
}

/** A pending row the TTL has not expired. */
function pendingRow(client: string | null) {
  return {
    user_id: 'user-123',
    client,
    pending_oauth: { state: 'st4te', codeVerifier: 'verifier', createdAt: new Date().toISOString() },
  };
}

beforeEach(() => {
  mockedExchange.mockClear();
  mockedExchange.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
});

describe('provider-callback redirect targets', () => {
  it('rejects non-GET without redirecting', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(null));
    const { res, statusCode, location } = makeRes();
    await handler(makeReq({}, 'POST'), res);
    expect(statusCode()).toBe(405);
    expect(location()).toBeNull();
  });

  it('sends a web connect back into the SPA on success', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(pendingRow(null)));
    const { res, statusCode, location } = makeRes();
    await handler(makeReq({ state: 'st4te', code: 'c0de' }), res);
    expect(statusCode()).toBe(302);
    expect(location()).toBe(WEB_OK);
  });

  it('sends an ios connect back into the app on success', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(pendingRow('ios')));
    const { res, statusCode, location } = makeRes();
    await handler(makeReq({ state: 'st4te', code: 'c0de' }), res);
    expect(statusCode()).toBe(302);
    expect(location()).toBe('apextraining://connected?provider=coros');
  });

  // Declining at COROS is the commonest failure and the one that must still
  // dismiss ASWebAuthenticationSession, which is why the pending row is now
  // read before this branch rather than after it.
  it('routes a declined ios consent to the app scheme with a reason', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(pendingRow('ios')));
    const { res, location } = makeRes();
    await handler(makeReq({ state: 'st4te', error: 'access_denied' }), res);
    expect(location()).toBe('apextraining://connect_error?provider=coros&reason=denied');
  });

  it('leaves the web failure string byte-identical, with no reason param', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(pendingRow(null)));
    const { res, location } = makeRes();
    await handler(makeReq({ state: 'st4te', error: 'access_denied' }), res);
    expect(location()).toBe(WEB_FAIL);
  });

  it('falls back to the web when there is no state to identify the client', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(pendingRow('ios')));
    const { res, location } = makeRes();
    await handler(makeReq({ code: 'c0de' }), res);
    expect(location()).toBe(WEB_FAIL);
  });

  it('reports an expired or missing pending row', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(null));
    const { res, location } = makeRes();
    await handler(makeReq({ state: 'st4te', code: 'c0de' }), res);
    expect(location()).toBe(WEB_FAIL);
  });

  it('reports an expired pending row to ios with reason=expired', async () => {
    const stale = pendingRow('ios');
    (stale.pending_oauth as { createdAt: string }).createdAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    mockedAdmin.mockReturnValue(makeAdmin(stale));
    const { res, location } = makeRes();
    await handler(makeReq({ state: 'st4te', code: 'c0de' }), res);
    // The row is found, so the client is known even though the dance is dead.
    expect(location()).toBe('apextraining://connect_error?provider=coros&reason=expired');
  });

  it('reports a failed token exchange', async () => {
    mockedExchange.mockRejectedValue(new Error('coros said no'));
    mockedAdmin.mockReturnValue(makeAdmin(pendingRow('ios')));
    const { res, location } = makeRes();
    await handler(makeReq({ state: 'st4te', code: 'c0de' }), res);
    expect(location()).toBe('apextraining://connect_error?provider=coros&reason=exchange_failed');
  });

  it('still redirects when the pending lookup itself throws', async () => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
    });
    mockedAdmin.mockReturnValue(
      { from: () => builder } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    );
    const { res, statusCode, location } = makeRes();
    await handler(makeReq({ state: 'st4te', code: 'c0de' }), res);
    expect(statusCode()).toBe(302);
    expect(location()).toBe(WEB_FAIL);
  });
});
