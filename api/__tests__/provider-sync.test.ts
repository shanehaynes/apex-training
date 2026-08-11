import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/providerSync';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { distanceLabel, elevationLabel, utcToLocal } from '../_lib/providers/sync';
import { parseQuantity } from '../../src/lib/tracking/records';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface Row { [k: string]: unknown }
interface AdminState {
  connections: Row[];
}

// Minimal query-builder stand-in for the connection reads the handler's
// status / connect-start / disconnect actions perform.
function makeAdmin(state: AdminState) {
  const table = (name: string) => ({
    select: () => table(name),
    eq: () => table(name),
    maybeSingle: async () => ({ data: state.connections[0] ?? null, error: null }),
    upsert: async (row: Row) => { state.connections = [row]; return { error: null }; },
    delete: () => ({ eq: () => ({ eq: async () => { state.connections = []; return { error: null }; } }) }),
  });
  return { from: table } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body?: unknown, method = 'POST'): VercelRequest {
  return { method, headers: {}, body, query: {} } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
    redirect() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

let state: AdminState;

beforeEach(() => {
  state = { connections: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
  delete process.env.COROS_CLIENT_ID;
  delete process.env.COROS_REDIRECT_URI;
});

describe('provider-sync handler', () => {
  it('rejects non-POST', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq(undefined, 'GET'), res);
    expect(statusCode()).toBe(405);
  });

  it('status reports disconnected + unconfigured with no row and no env', async () => {
    const { res, body } = makeRes();
    await handler(makeReq({ action: 'status' }), res);
    expect(body()).toEqual({
      coros: {
        status: 'disconnected', lastSyncedAt: null, connectedAt: null,
        configured: false, autoSync: true, pendingFillCount: 0,
      },
    });
  });

  it('status projects an existing connection without token material', async () => {
    state.connections = [{
      user_id: 'user-123', provider: 'coros', status: 'connected',
      access_token: 'enc:v1:secret', refresh_token: 'enc:v1:secret2',
      last_synced_at: '2026-08-09T00:00:00Z', connected_at: '2026-08-01T00:00:00Z',
    }];
    const { res, body } = makeRes();
    await handler(makeReq({ action: 'status' }), res);
    const coros = (body() as { coros: Record<string, unknown> }).coros;
    expect(coros.status).toBe('connected');
    expect(coros.lastSyncedAt).toBe('2026-08-09T00:00:00Z');
    expect(JSON.stringify(body())).not.toContain('secret');
  });

  it('400s an unknown provider', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ action: 'connect-start', provider: 'garmin' }), res);
    expect(statusCode()).toBe(400);
  });

  it('400s an unknown action', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ action: 'sync-everything', provider: 'coros' }), res);
    expect(statusCode()).toBe(400);
  });

  it('503s connect-start when the deployment has no COROS client', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ action: 'connect-start', provider: 'coros' }), res);
    expect(statusCode()).toBe(503);
  });

  it('disconnect deletes the connection row', async () => {
    state.connections = [{ user_id: 'user-123', provider: 'coros', status: 'connected' }];
    const { res, body } = makeRes();
    await handler(makeReq({ action: 'disconnect', provider: 'coros' }), res);
    expect(body()).toEqual({ ok: true });
    expect(state.connections).toEqual([]);
  });
});

describe('utcToLocal', () => {
  it('converts UTC instants into local calendar dates and display times', () => {
    // 13:32 UTC on Aug 10 is 6:32 AM in Seattle (PDT, UTC-7).
    expect(utcToLocal('2026-08-10T13:32:00Z', 'America/Los_Angeles')).toEqual({
      date: '2026-08-10',
      minutes: 6 * 60 + 32,
      display: '6:32 AM',
    });
  });

  it('rolls the calendar date across midnight', () => {
    // 05:30 UTC on Aug 10 is 10:30 PM Aug 9 in Seattle.
    expect(utcToLocal('2026-08-10T05:30:00Z', 'America/Los_Angeles')).toEqual({
      date: '2026-08-09',
      minutes: 22 * 60 + 30,
      display: '10:30 PM',
    });
  });

  it('handles local midnight without an hour-24 artifact', () => {
    const local = utcToLocal('2026-08-10T07:00:00Z', 'America/Los_Angeles');
    expect(local.display).toBe('12:00 AM');
    expect(local.minutes).toBe(0);
  });
});

describe('unit serialization', () => {
  it('emits parseQuantity-compatible distance strings', () => {
    const label = distanceLabel(8368.6);
    expect(label).toBe('5.20 mi');
    expect(parseQuantity(label)).toEqual({ value: 5.2, unit: 'mi' });
  });

  it('emits parseQuantity-compatible elevation strings', () => {
    const label = elevationLabel(250);
    expect(label).toBe('820 ft');
    expect(parseQuantity(label)).toEqual({ value: 820, unit: 'ft' });
  });

  it('returns null for missing or zero values', () => {
    expect(distanceLabel(undefined)).toBeNull();
    expect(distanceLabel(0)).toBeNull();
    expect(elevationLabel(undefined)).toBeNull();
  });
});
