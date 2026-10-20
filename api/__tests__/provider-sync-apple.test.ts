import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { APPLE_DISCONNECT_NOTICE } from '../_lib/handlers/providerSync';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { parseCategories } from '../_lib/providers/connection';

// Apple Health's connection lifecycle (W16 M2b): connect, set-categories,
// status, disconnect, and the gates in front of the sync actions. The sync
// itself runs against the local stack (integration/provider-sync).

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

type Row = Record<string, unknown>;
interface State {
  /** provider_connections, one row per provider for user-123. */
  connections: Map<string, Row>;
  dailyMetrics: Row[];
}

/** A fake that honours the provider filter, unlike provider-sync.test.ts's
 *  single-row stand-in: Apple and COROS rows coexist for one user. */
function makeAdmin(state: State) {
  function connections() {
    const filters: Record<string, unknown> = {};
    let op: 'select' | 'update' | 'delete' = 'select';
    let patch: Row = {};
    const b: Record<string, unknown> = {};
    const matching = () => [...state.connections.values()].filter(r => Object.entries(filters).every(([k, v]) => r[k] === v));
    b.select = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => ({ data: matching()[0] ?? null, error: null });
    b.upsert = async (row: Row) => {
      state.connections.set(row.provider as string, { ...(state.connections.get(row.provider as string) ?? {}), ...row });
      return { error: null };
    };
    b.update = (row: Row) => { op = 'update'; patch = row; return b; };
    b.delete = () => { op = 'delete'; return b; };
    b.then = (resolve: (v: unknown) => unknown) => {
      for (const row of matching()) {
        if (op === 'update') Object.assign(row, patch);
        if (op === 'delete') state.connections.delete(row.provider as string);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    };
    return b;
  }
  function dailyMetrics() {
    const filters: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.delete = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.select = async () => {
      const gone = state.dailyMetrics.filter(r => Object.entries(filters).every(([k, v]) => r[k] === v));
      state.dailyMetrics = state.dailyMetrics.filter(r => !gone.includes(r));
      return { data: gone, error: null };
    };
    return b;
  }
  return {
    from(table: string) {
      if (table === 'provider_connections') return connections();
      if (table === 'daily_metrics') return dailyMetrics();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown): VercelRequest {
  return { method: 'POST', headers: {}, body, query: {} } as unknown as VercelRequest;
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

async function call(body: unknown) {
  const r = makeRes();
  await handler(makeReq(body), r.res);
  return r;
}

const TZ = 'America/New_York';
const connect = (categories: unknown = { workoutsRead: true }) =>
  call({ action: 'connect', provider: 'apple', client: 'ios', timezone: TZ, categories });

let state: State;

beforeEach(() => {
  state = { connections: new Map(), dailyMetrics: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

describe('apple: connect, set-categories, status', () => {
  it('connect upserts a connected row with no token and no nightly job', async () => {
    const r = await connect({ workoutsRead: true, dailyMetrics: false });
    expect(r.statusCode()).toBe(200);
    expect(r.body()).toMatchObject({ ok: true, apple: { status: 'connected', categories: { workoutsRead: true, dailyMetrics: false } } });
    expect(state.connections.get('apple')).toMatchObject({
      status: 'connected', access_token: null, refresh_token: null, auto_sync: false, client: 'ios', timezone: TZ,
    });
  });

  it('a reconnect keeps the earlier opt-ins it does not name, and the first connected_at', async () => {
    await connect({ workoutsRead: true, bodyMass: true });
    const first = state.connections.get('apple')!.connected_at;
    const r = await connect({ dailyMetrics: true });
    expect((r.body().apple as Row).categories).toEqual({ workoutsRead: true, bodyMass: true, dailyMetrics: true });
    expect(state.connections.get('apple')!.connected_at).toBe(first);
  });

  it('set-categories merges, and 409s without a connection', async () => {
    const before = await call({ action: 'set-categories', provider: 'apple', client: 'ios', categories: { workoutsRead: false } });
    expect(before.statusCode()).toBe(409);
    expect(before.body()).toEqual({ error: 'not-connected' });

    await connect({ workoutsRead: true });
    const r = await call({ action: 'set-categories', provider: 'apple', client: 'ios', categories: { dailyMetrics: true } });
    expect(r.body()).toEqual({ ok: true, categories: { workoutsRead: true, dailyMetrics: true } });
  });

  it('refuses unknown categories, non-boolean values and an empty change', async () => {
    for (const categories of [{ steps: true }, { workoutsRead: 'yes' }, [], 'all']) {
      expect((await connect(categories)).statusCode(), JSON.stringify(categories)).toBe(400);
    }
    await connect();
    const empty = await call({ action: 'set-categories', provider: 'apple', client: 'ios', categories: {} });
    expect(empty.statusCode()).toBe(400);
    expect(parseCategories({ workoutsWrite: true, mealsWrite: false })).toEqual({ workoutsWrite: true, mealsWrite: false });
  });

  it('connect needs a valid zone', async () => {
    const r = await call({ action: 'connect', provider: 'apple', client: 'ios', timezone: 'Mars/Base', categories: {} });
    expect(r.statusCode()).toBe(400);
  });

  it('status reports apple beside coros', async () => {
    await connect({ workoutsRead: true });
    const r = await call({ action: 'status' });
    expect(r.body().apple).toMatchObject({ status: 'connected', lastSyncedAt: null, categories: { workoutsRead: true } });
    expect(r.body().coros).toMatchObject({ status: 'disconnected' });
  });
});

describe('apple: disconnect', () => {
  it('drops the row and keeps the metrics unless asked', async () => {
    await connect();
    state.dailyMetrics = [{ user_id: 'user-123', provider: 'apple', date: '2026-10-14' }];
    const r = await call({ action: 'disconnect', provider: 'apple' });
    expect(r.body()).toEqual({ ok: true, purged: { dailyMetrics: 0 }, notice: APPLE_DISCONNECT_NOTICE });
    expect(state.connections.has('apple')).toBe(false);
    expect(state.dailyMetrics).toHaveLength(1);
  });

  it('purges the metrics on request, and works from the web too', async () => {
    await connect();
    state.dailyMetrics = [
      { user_id: 'user-123', provider: 'apple', date: '2026-10-14' },
      { user_id: 'user-123', provider: 'apple', date: '2026-10-15' },
    ];
    const r = await call({ action: 'disconnect', provider: 'apple', purgeMetrics: true });
    expect(r.body()).toMatchObject({ purged: { dailyMetrics: 2 } });
    expect(state.dailyMetrics).toEqual([]);
  });

  it('refuses a non-boolean purgeMetrics', async () => {
    expect((await call({ action: 'disconnect', provider: 'apple', purgeMetrics: 'yes' })).statusCode()).toBe(400);
  });

  it('leaves a COROS connection alone', async () => {
    state.connections.set('coros', { user_id: 'user-123', provider: 'coros', status: 'connected' });
    await connect();
    await call({ action: 'disconnect', provider: 'apple' });
    expect(state.connections.has('coros')).toBe(true);
  });
});

describe('apple: the gates', () => {
  it('only the iOS app drives Health (disconnect excepted)', async () => {
    for (const action of ['connect', 'set-categories', 'preview', 'apply', 'ingest']) {
      const r = await call({ action, provider: 'apple', timezone: TZ, categories: { workoutsRead: true } });
      expect(r.statusCode(), action).toBe(400);
      expect(r.body(), action).toBe('Apple Health actions come from the iOS app');
    }
  });

  it('connect-start and set-auto-sync are not Apple actions; connect and ingest are not COROS ones', async () => {
    for (const action of ['connect-start', 'set-auto-sync']) {
      expect((await call({ action, provider: 'apple', client: 'ios', enabled: true })).statusCode(), action).toBe(400);
    }
    for (const action of ['connect', 'set-categories', 'ingest']) {
      expect((await call({ action, provider: 'coros' })).statusCode(), action).toBe(400);
    }
  });

  it('a sync without a connection is 409 not-connected', async () => {
    const r = await call({ action: 'preview', provider: 'apple', client: 'ios', timezone: TZ, activities: [] });
    expect(r.statusCode()).toBe(409);
    expect(r.body()).toEqual({ error: 'not-connected' });
  });

  it('a sync without the workoutsRead opt-in is 409 category-off', async () => {
    await connect({ workoutsRead: false, dailyMetrics: true });
    for (const action of ['preview', 'apply', 'ingest']) {
      const r = await call({ action, provider: 'apple', client: 'ios', timezone: TZ, activities: [] });
      expect(r.statusCode(), action).toBe(409);
      expect(r.body(), action).toEqual({ error: 'category-off', category: 'workoutsRead' });
    }
  });

  it('a malformed batch is a 400 once consent is in place', async () => {
    await connect({ workoutsRead: true });
    const r = await call({ action: 'preview', provider: 'apple', client: 'ios', timezone: TZ, activities: [{ activityId: 'x' }] });
    expect(r.statusCode()).toBe(400);
  });
});
