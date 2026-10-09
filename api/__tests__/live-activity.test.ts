import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { apnsConfig, providerToken, resetApnsTokenCache, sendApns, type ApnsConfig, type ApnsTransport } from '../_lib/apns';
import {
  LIVE_ACTIVITY_TOPIC,
  endLiveActivities,
  endPayload,
  forgetLiveActivityTokens,
  registerLiveActivityToken,
} from '../_lib/services/liveActivity';
import handler from '../_lib/handlers/liveActivityTokens';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn(() => ({})) }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

// The end push is the contract between two codebases that never run
// together: this server writes `content-state`, and the phone decodes it into
// TrackerActivityAttributes.ContentState with a default JSONDecoder. The
// fixture is the vector both sides test against — this file writes it
// (APEX_FIXTURES_WRITE=1), ios/ApexTests/LiveActivityPushTests.swift decodes it.
const FIXTURE = join(__dirname, '..', '..', 'ios', 'Fixtures', 'live-activity-end.json');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function makeConfig(): { config: ApnsConfig; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { config: { keyId: 'KEY1234567', teamId: 'TEAM123456', privateKey }, publicKey };
}

interface Call { table: string; op: string; args: unknown[] }

/** Records every builder call; `select` resolves to `rows`. */
function makeAdmin(rows: Record<string, unknown>[] = [], errors: { select?: string; upsert?: string } = {}) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const chain = (op: string, result: unknown) => {
        const builder: Record<string, unknown> = {};
        for (const m of ['eq', 'lt', 'in']) {
          builder[m] = (...args: unknown[]) => { calls.push({ table, op: `${op}.${m}`, args }); return builder; };
        }
        builder.then = (resolve: (v: unknown) => void) => resolve(result);
        return builder;
      };
      return {
        select: (...args: unknown[]) => {
          calls.push({ table, op: 'select', args });
          return chain('select', errors.select ? { data: null, error: { message: errors.select } } : { data: rows, error: null });
        },
        delete: () => { calls.push({ table, op: 'delete', args: [] }); return chain('delete', { error: null }); },
        upsert: async (...args: unknown[]) => {
          calls.push({ table, op: 'upsert', args });
          return { error: errors.upsert ? { message: errors.upsert } : null };
        },
      };
    },
  };
  return { admin: admin as never, calls };
}

describe('APNs provider token', () => {
  beforeEach(() => resetApnsTokenCache());

  it('is an ES256 JWT over {alg, kid}.{iss, iat} that verifies with the key', () => {
    const { config, publicKey } = makeConfig();
    const jwt = providerToken(config, Date.UTC(2026, 9, 9, 12, 0, 0));
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAM123456', iat: 1791547200 });
    // Raw r||s (64 bytes), not DER — what JWS and APNs expect.
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'));
    expect(ok).toBe(true);
  });

  it('is reused inside 50 minutes and re-signed after', async () => {
    const { config } = makeConfig();
    const seen: string[] = [];
    const transport: ApnsTransport = async (_host, headers) => { seen.push(headers.authorization); return { status: 200 }; };
    const request = { token: TOKEN, environment: 'production' as const, topic: 't', pushType: 'liveactivity' as const, priority: 10 as const, payload: {} };
    const t0 = Date.UTC(2026, 9, 9, 12, 0, 0);
    await sendApns(config, request, transport, t0);
    await sendApns(config, request, transport, t0 + 49 * 60_000);
    await sendApns(config, request, transport, t0 + 51 * 60_000);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });
});

describe('apnsConfig', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('is null unless all three variables are set', () => {
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_PRIVATE_KEY;
    expect(apnsConfig()).toBeNull();
    process.env.APNS_KEY_ID = 'K';
    process.env.APNS_TEAM_ID = 'T';
    expect(apnsConfig()).toBeNull();
  });

  it('reads a PEM whose newlines were written as \\n escapes', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.APNS_KEY_ID = 'K';
    process.env.APNS_TEAM_ID = 'T';
    process.env.APNS_PRIVATE_KEY = pem.replace(/\n/g, '\\n');
    expect(apnsConfig()?.keyId).toBe('K');
  });

  it('is null, not a throw, for a key that is not PEM', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.APNS_KEY_ID = 'K';
    process.env.APNS_TEAM_ID = 'T';
    process.env.APNS_PRIVATE_KEY = 'not a key';
    expect(apnsConfig()).toBeNull();
    spy.mockRestore();
  });
});

describe('the end payload', () => {
  it('matches the fixture the phone decodes', () => {
    const payload = endPayload(new Date('2026-09-08T17:00:00.000Z'), 2712, Date.parse('2026-09-08T17:45:12.000Z'));
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (process.env.APEX_FIXTURES_WRITE) writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), 'live-activity-end.json missing — run with APEX_FIXTURES_WRITE=1').toBe(true);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(text);
  });

  it('carries the start as seconds since 2001, which is what a default JSONDecoder reads', () => {
    const payload = endPayload(new Date('2001-01-01T00:01:40.000Z'), 5, 0);
    expect(payload.aps['content-state'].startedAt).toBe(100);
    expect(payload.aps['content-state'].phase).toEqual({ done: { totalSeconds: 5 } });
  });

  it('dismisses at once: dismissal-date is the push time', () => {
    const payload = endPayload(new Date(0), 1, 1_791_547_200_500);
    expect(payload.aps).toMatchObject({ event: 'end', timestamp: 1791547200, 'dismissal-date': 1791547200 });
  });
});

describe('endLiveActivities', () => {
  const session = { eventId: 'evt-1', eventDate: '2026-09-08' };
  const row = { id: 'row-1', push_token: TOKEN, environment: 'sandbox', started_at: '2026-09-08T17:00:00.000Z' };

  beforeEach(() => resetApnsTokenCache());

  it('does nothing — not even a read — when APNs is not configured', async () => {
    const { admin, calls } = makeAdmin([row]);
    expect(await endLiveActivities(admin, 'user-123', session, {}, { config: null })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('pushes end to each registered token on the right host and topic, then forgets them', async () => {
    const { config } = makeConfig();
    const { admin, calls } = makeAdmin([row, { ...row, id: 'row-2', environment: 'production' }]);
    const sent: { host: string; headers: Record<string, string>; body: unknown }[] = [];
    const transport: ApnsTransport = async (host, headers, body) => {
      sent.push({ host, headers, body: JSON.parse(body) });
      return { status: 200 };
    };
    const now = Date.parse('2026-09-08T17:45:12.000Z');
    const accepted = await endLiveActivities(admin, 'user-123', session, { totalSeconds: 2700 }, { config, transport, nowMs: now });

    expect(accepted).toBe(2);
    expect(sent.map(s => s.host)).toEqual(['https://api.sandbox.push.apple.com', 'https://api.push.apple.com']);
    expect(sent[0].headers).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${TOKEN}`,
      'apns-topic': LIVE_ACTIVITY_TOPIC,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
    });
    expect(sent[0].body).toEqual(endPayload(new Date(row.started_at), 2700, now));
    // Scoped to the user and the session.
    expect(calls.filter(c => c.op === 'select.eq').map(c => c.args)).toEqual([
      ['user_id', 'user-123'], ['event_id', 'evt-1'], ['event_date', '2026-09-08'],
    ]);
    expect(calls.find(c => c.op === 'delete.in')?.args).toEqual(['id', ['row-1', 'row-2']]);
  });

  it('falls back to the time since the start when the caller has no total', async () => {
    const { config } = makeConfig();
    const { admin } = makeAdmin([row]);
    let body: ReturnType<typeof endPayload> | undefined;
    const transport: ApnsTransport = async (_h, _hd, b) => { body = JSON.parse(b); return { status: 200 }; };
    await endLiveActivities(admin, 'user-123', session, {}, { config, transport, nowMs: Date.parse('2026-09-08T17:10:00.000Z') });
    expect(body?.aps['content-state'].phase).toEqual({ done: { totalSeconds: 600 } });
  });

  it('retries the other APNs host when the token belongs there', async () => {
    const { config } = makeConfig();
    const { admin } = makeAdmin([row]);
    const hosts: string[] = [];
    const transport: ApnsTransport = async host => {
      hosts.push(host);
      return host.includes('sandbox') ? { status: 400, reason: 'BadDeviceToken' } : { status: 200 };
    };
    expect(await endLiveActivities(admin, 'user-123', session, {}, { config, transport })).toBe(1);
    expect(hosts).toEqual(['https://api.sandbox.push.apple.com', 'https://api.push.apple.com']);
  });

  it('forgets a token APNs refused and never throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { config } = makeConfig();
    const { admin, calls } = makeAdmin([row]);
    const transport: ApnsTransport = async () => ({ status: 410, reason: 'ExpiredToken' });
    expect(await endLiveActivities(admin, 'user-123', session, {}, { config, transport })).toBe(0);
    expect(calls.some(c => c.op === 'delete.in')).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('410 ExpiredToken'));

    const throwing: ApnsTransport = async () => { throw new Error('socket hang up'); };
    await expect(endLiveActivities(admin, 'user-123', session, {}, { config, transport: throwing })).resolves.toBe(0);
    spy.mockRestore();
  });

  it('is a no-op on a failed read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { config } = makeConfig();
    const { admin, calls } = makeAdmin([], { select: 'relation does not exist' });
    const transport = vi.fn<ApnsTransport>();
    expect(await endLiveActivities(admin, 'user-123', session, {}, { config, transport })).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(calls.some(c => c.op === 'delete')).toBe(false);
    spy.mockRestore();
  });
});

describe('registerLiveActivityToken', () => {
  const valid = { eventId: 'evt-1', eventDate: '2026-09-08', token: TOKEN.toUpperCase(), environment: 'production', startedAt: '2026-09-08T17:00:00Z' };

  it('upserts on the token, lower-cased, and sweeps this user\'s day-old rows', async () => {
    const { admin, calls } = makeAdmin();
    const now = Date.parse('2026-09-09T12:00:00.000Z');
    const result = await registerLiveActivityToken(admin, 'user-123', valid, now);
    expect(result.ok).toBe(true);
    const upsert = calls.find(c => c.op === 'upsert');
    expect(upsert?.args).toEqual([{
      user_id: 'user-123', event_id: 'evt-1', event_date: '2026-09-08', push_token: TOKEN,
      environment: 'production', started_at: '2026-09-08T17:00:00.000Z', created_at: '2026-09-09T12:00:00.000Z',
    }, { onConflict: 'push_token' }]);
    expect(calls.filter(c => c.op.startsWith('delete.')).map(c => c.args)).toEqual([
      ['user_id', 'user-123'], ['created_at', '2026-09-08T12:00:00.000Z'],
    ]);
  });

  it.each([
    [{ eventId: '' }, 'eventId'],
    [{ eventDate: '9/8/2026' }, 'eventDate'],
    [{ token: 'not-hex' }, 'token'],
    [{ token: 'abc' }, 'token'],
    [{ environment: 'staging' }, 'environment'],
    [{ startedAt: 'yesterday' }, 'startedAt'],
  ])('400s on %o and writes nothing', async (patch, field) => {
    const { admin, calls } = makeAdmin();
    const result = await registerLiveActivityToken(admin, 'user-123', { ...valid, ...patch });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.message).toContain(field);
    expect(calls).toEqual([]);
  });

  it('500s when the upsert fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = makeAdmin([], { upsert: 'boom' });
    expect(await registerLiveActivityToken(admin, 'user-123', valid)).toMatchObject({ ok: false, status: 500 });
    spy.mockRestore();
  });
});

describe('forgetLiveActivityTokens', () => {
  it('deletes this user\'s rows for the session', async () => {
    const { admin, calls } = makeAdmin();
    expect((await forgetLiveActivityTokens(admin, 'user-123', { eventId: 'evt-1', eventDate: '2026-09-08' })).ok).toBe(true);
    expect(calls.filter(c => c.op === 'delete.eq').map(c => c.args)).toEqual([
      ['user_id', 'user-123'], ['event_id', 'evt-1'], ['event_date', '2026-09-08'],
    ]);
  });

  it('400s without a session', async () => {
    const { admin } = makeAdmin();
    expect(await forgetLiveActivityTokens(admin, 'user-123', {})).toMatchObject({ ok: false, status: 400 });
  });
});

describe('/api/live-activity-tokens', () => {
  function makeRes() {
    let code = 0;
    const res = {
      status(c: number) { code = c; return res; },
      send() { return res; },
      json() { return res; },
      setHeader() { return res; },
    } as unknown as VercelResponse;
    return { res, statusCode: () => code };
  }

  it('405s anything but POST and DELETE', async () => {
    const { res, statusCode } = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} } as unknown as VercelRequest, res);
    expect(statusCode()).toBe(405);
  });

  it('400s a POST with no body', async () => {
    const { res, statusCode } = makeRes();
    await handler({ method: 'POST', headers: {}, query: {} } as unknown as VercelRequest, res);
    expect(statusCode()).toBe(400);
  });
});
