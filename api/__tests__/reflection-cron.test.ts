import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { BACKLOG_DAYS, MAX_WORK_ITEMS_PER_RUN, rotateForDay } from '../_lib/handlers/reflectionCron';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getAnthropicKey } from '../_lib/anthropicKey';
import { reflectForUser } from '../_lib/reflection/reflect';
import { fetchReflectionInputs } from '../_lib/reflection/inputs';
import { REFLECTION_SYSTEM_PROMPT } from '../_lib/reflection/prompt';

// The cron target (lane D01): the CRON_SECRET door, the opted-in listing
// (and the column not being there yet), the per-user key and model, the
// work budget, per-user isolation, and the dry run. The reflection itself
// is scripted — its own suite is reflection.test.ts.

const { clientOptions } = vi.hoisted(() => ({ clientOptions: [] as Array<Record<string, unknown>> }));

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn() }));
vi.mock('../_lib/reflection/reflect.js', () => ({ reflectForUser: vi.fn() }));
vi.mock('../_lib/reflection/inputs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/reflection/inputs.js')>()),
  fetchReflectionInputs: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor(options: Record<string, unknown>) { clientOptions.push(options); }
    messages = { create: vi.fn() };
  }
  return { default: MockAnthropic };
});

const mockedKey = vi.mocked(getAnthropicKey);
const mockedReflect = vi.mocked(reflectForUser);
const mockedInputs = vi.mocked(fetchReflectionInputs);

interface ProfileRow { id: string; coach_model: string | null; reflection_opt_in: boolean }
interface ReflectionRow { user_id: string; day: string; status: string }
type Row = Record<string, unknown>;
let profiles: ProfileRow[];
let reflections: ReflectionRow[];
let optInColumnMissing: boolean;

// Two tables, the filters applied as sent, so a backlog query that forgets
// the status or the window shows up as the wrong rows.
function makeAdmin() {
  return {
    from(table: string) {
      expect(['profiles', 'coach_reflections']).toContain(table);
      const filters: Array<(r: Row) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, v: unknown) => { filters.push(r => r[col] === v); return b; };
      b.in = (col: string, vs: unknown[]) => { filters.push(r => vs.includes(r[col])); return b; };
      b.gte = (col: string, v: string) => { filters.push(r => String(r[col]) >= v); return b; };
      b.lt = (col: string, v: string) => { filters.push(r => String(r[col]) < v); return b; };
      b.order = (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return b; };
      b.then = (resolve: (v: unknown) => void) => {
        if (table === 'profiles' && optInColumnMissing) {
          resolve({ data: null, error: { code: '42703', message: 'column profiles.reflection_opt_in does not exist' } });
          return;
        }
        const rows = (table === 'profiles' ? profiles : reflections) as unknown as Row[];
        let matched = rows.filter(r => filters.every(f => f(r)));
        for (const { col, asc } of [...orders].reverse()) {
          matched = [...matched].sort((a, c) => String(a[col]).localeCompare(String(c[col])) * (asc ? 1 : -1));
        }
        resolve({ data: matched, error: null });
      };
      return b;
    },
  } as never;
}

function makeReq(query: Record<string, string> = {}, auth: string | null = 'Bearer test-secret'): VercelRequest {
  return { method: 'GET', headers: auth ? { authorization: auth } : {}, query } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse;
  return {
    res,
    statusCode: () => code,
    body: () => payload as { day?: string; processed?: Array<{ userId: string; day: string; action: string }>; errors?: Array<{ userId: string; day: string; error: string }>; note?: string },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientOptions.length = 0;
  process.env.CRON_SECRET = 'test-secret';
  optInColumnMissing = false;
  reflections = [];
  profiles = [
    { id: 'u-b', coach_model: 'claude-sonnet-5', reflection_opt_in: true },
    { id: 'u-a', coach_model: null, reflection_opt_in: true },
    { id: 'u-off', coach_model: null, reflection_opt_in: false },
  ];
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  mockedKey.mockImplementation(async (_db, userId) => (userId === 'u-a' ? null : `sk-ant-${userId}`));
  mockedReflect.mockResolvedValue({ action: 'done', rowId: 'r1', memoriesProposed: 1, contractProposed: false });
});

describe('reflection-cron handler', () => {
  it('401s without the secret, or with the wrong one, and never runs', async () => {
    for (const auth of [null, 'Bearer wrong']) {
      const { res, statusCode } = makeRes();
      await handler(makeReq({}, auth), res);
      expect(statusCode()).toBe(401);
    }
    delete process.env.CRON_SECRET;
    const { res, statusCode } = makeRes();
    await handler(makeReq({}, 'Bearer undefined'), res);
    expect(statusCode()).toBe(401);
    expect(mockedReflect).not.toHaveBeenCalled();
  });

  it('reflects on yesterday (UTC) for every opted-in athlete with a key, on their own key and model, in a fixed order', async () => {
    const { res, statusCode, body } = makeRes();
    const before = Date.now();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    const day = new Date(before - 86_400_000).toISOString().slice(0, 10);
    expect(body().day).toBe(day);
    expect(body().processed).toEqual(expect.arrayContaining([
      { userId: 'u-a', day, action: 'skipped-no-key' },
      { userId: 'u-b', day, action: 'done', memoriesProposed: 1, contractProposed: false },
    ]));
    expect(body().processed).toHaveLength(2);
    expect(body().errors).toEqual([]);
    expect(mockedReflect).toHaveBeenCalledTimes(1);
    const [, req] = mockedReflect.mock.calls[0];
    expect(req).toMatchObject({ userId: 'u-b', day: body().day, model: 'claude-sonnet-5' });
    // The client is built with the shared timeout/retry posture on the athlete's key.
    expect(clientOptions).toEqual([{ apiKey: 'sk-ant-u-b', maxRetries: 1, timeout: 20_000 }]);
    // The opted-out athlete was never looked at.
    expect(mockedKey).not.toHaveBeenCalledWith(expect.anything(), 'u-off');
  });

  it('resolves a null coach_model to the default model id', async () => {
    mockedKey.mockResolvedValue('sk-ant-any');
    const { res } = makeRes();
    await handler(makeReq({ userId: 'u-a' }), res);
    const [, req] = mockedReflect.mock.calls[0];
    expect(typeof req.model).toBe('string');
    expect(req.model.length).toBeGreaterThan(0);
  });

  it('answers 200 with a note, and does nothing, while the opt-in column is not there yet', async () => {
    optInColumnMissing = true;
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ processed: [], errors: [], note: 'reflection_opt_in column missing' });
    expect(mockedReflect).not.toHaveBeenCalled();
  });

  it('takes ?userId= and ?day=, and 400s a malformed day', async () => {
    mockedKey.mockResolvedValue('sk-ant-any');
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ userId: 'u-b', day: '2026-09-20' }), res);
    expect(statusCode()).toBe(200);
    expect(body().day).toBe('2026-09-20');
    expect(body().processed).toEqual([{ userId: 'u-b', day: '2026-09-20', action: 'done', memoriesProposed: 1, contractProposed: false }]);
    expect(mockedReflect.mock.calls[0][1]).toMatchObject({ userId: 'u-b', day: '2026-09-20' });

    const bad = makeRes();
    await handler(makeReq({ day: '20/09/2026' }), bad.res);
    expect(bad.statusCode()).toBe(400);
  });

  it('stops starting model calls at the work budget and defers the rest to the next night', async () => {
    profiles = Array.from({ length: MAX_WORK_ITEMS_PER_RUN + 3 }, (_, i) => ({
      id: `u-${String(i).padStart(2, '0')}`, coach_model: null, reflection_opt_in: true,
    }));
    mockedKey.mockResolvedValue('sk-ant-any');
    const { res, body } = makeRes();
    await handler(makeReq(), res);
    expect(mockedReflect).toHaveBeenCalledTimes(MAX_WORK_ITEMS_PER_RUN);
    const actions = body().processed!.map(p => p.action);
    expect(actions.filter(a => a === 'done')).toHaveLength(MAX_WORK_ITEMS_PER_RUN);
    expect(actions.filter(a => a === 'deferred')).toHaveLength(3);
    expect(actions.slice(-3)).toEqual(['deferred', 'deferred', 'deferred']);
  });

  it('a key read that throws, or a reflection that throws, is one athlete\'s error and the run goes on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    profiles = [
      { id: 'u-1', coach_model: null, reflection_opt_in: true },
      { id: 'u-2', coach_model: null, reflection_opt_in: true },
      { id: 'u-3', coach_model: null, reflection_opt_in: true },
    ];
    mockedKey.mockImplementation(async (_db, userId) => {
      if (userId === 'u-1') throw new Error('decrypt failed');
      return 'sk-ant-any';
    });
    mockedReflect.mockImplementation(async (_db, req) => {
      if (req.userId === 'u-2') throw new Error('exploded');
      return { action: 'failed', rowId: 'r3', memoriesProposed: 0, contractProposed: false, error: 'reflection output invalid after retry' };
    });
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ day: '2026-09-20' }), res);
    expect(statusCode()).toBe(200);
    // 2026-09-20 rotates three athletes to start at index 1 (see the rotation case).
    expect(body().processed).toEqual([{ userId: 'u-3', day: '2026-09-20', action: 'failed', memoriesProposed: 0, contractProposed: false }]);
    expect(body().errors).toEqual(expect.arrayContaining([
      { userId: 'u-1', day: '2026-09-20', error: 'decrypt failed' },
      { userId: 'u-2', day: '2026-09-20', error: 'exploded' },
      { userId: 'u-3', day: '2026-09-20', error: 'reflection output invalid after retry' },
    ]));
    expect(body().errors).toHaveLength(3);
    error.mockRestore();
  });

  it('dry run renders the prompt for one athlete and touches nothing', async () => {
    mockedInputs.mockResolvedValue({
      day: '2026-09-27', sessions: [], messages: [{ role: 'user', text: 'hi' }], physiology: '', memories: [], pendingMemories: [], contract: 'Be blunt.',
    });
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ dryRun: '1', userId: 'u-b', day: '2026-09-27' }), res);
    expect(statusCode()).toBe(200);
    const out = body() as unknown as { dryRun: boolean; day: string; model: string; system: string; user: string };
    expect(out).toMatchObject({ dryRun: true, day: '2026-09-27', model: 'claude-sonnet-5', system: REFLECTION_SYSTEM_PROMPT });
    expect(out.user).toContain('Athlete: hi');
    expect(out.user).toContain('Be blunt.');
    expect(mockedReflect).not.toHaveBeenCalled();
    expect(mockedKey).not.toHaveBeenCalled();

    const bad = makeRes();
    await handler(makeReq({ dryRun: '1' }), bad.res);
    expect(bad.statusCode()).toBe(400);
    const off = makeRes();
    await handler(makeReq({ dryRun: '1', userId: 'u-off' }), off.res);
    expect(off.statusCode()).toBe(400);
  });
});

describe('reflection-cron — backlog and rotation', () => {
  it('retries pending/failed rows from earlier nights first, through the resume path, each costing one budget item', async () => {
    mockedKey.mockResolvedValue('sk-ant-any');
    reflections = [
      { user_id: 'u-b', day: '2026-09-18', status: 'failed' },
      { user_id: 'u-a', day: '2026-09-19', status: 'pending' },
      { user_id: 'u-b', day: '2026-09-19', status: 'done' },
      { user_id: 'u-off', day: '2026-09-19', status: 'failed' },       // opted out: not this run's
      { user_id: 'u-b', day: '2026-09-01', status: 'failed' },         // outside the window
      { user_id: 'u-a', day: '2026-09-20', status: 'failed' },         // today's own row: the main pass resumes it
    ];
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ day: '2026-09-20' }), res);
    expect(statusCode()).toBe(200);
    const pairs = mockedReflect.mock.calls.map(([, r]) => `${r.userId}@${r.day}`);
    // Oldest first, then today's pass for everyone (2026-09-20 rotates two athletes to start at u-a).
    expect(pairs).toEqual(['u-b@2026-09-18', 'u-a@2026-09-19', 'u-a@2026-09-20', 'u-b@2026-09-20']);
    expect(body().processed!.map(p => `${p.userId}@${p.day}`)).toEqual(pairs);
    // One key read per athlete, not per item.
    expect(mockedKey).toHaveBeenCalledTimes(2);
  });

  it('the backlog window is BACKLOG_DAYS and ?userId= narrows it too', async () => {
    mockedKey.mockResolvedValue('sk-ant-any');
    const inside = new Date(Date.UTC(2026, 8, 20 - BACKLOG_DAYS)).toISOString().slice(0, 10);
    const outside = new Date(Date.UTC(2026, 8, 20 - BACKLOG_DAYS - 1)).toISOString().slice(0, 10);
    reflections = [
      { user_id: 'u-b', day: inside, status: 'failed' },
      { user_id: 'u-b', day: outside, status: 'failed' },
      { user_id: 'u-a', day: '2026-09-19', status: 'failed' },
    ];
    const { res, body } = makeRes();
    await handler(makeReq({ day: '2026-09-20', userId: 'u-b' }), res);
    expect(body().processed!.map(p => `${p.userId}@${p.day}`)).toEqual([`u-b@${inside}`, 'u-b@2026-09-20']);
  });

  it('backlog items spend the budget before today\'s pass, and the rest defer', async () => {
    mockedKey.mockResolvedValue('sk-ant-any');
    reflections = Array.from({ length: MAX_WORK_ITEMS_PER_RUN }, (_, i) => ({
      user_id: 'u-b', day: `2026-09-${String(13 + (i % 7)).padStart(2, '0')}`, status: i % 2 ? 'failed' : 'pending',
    })).filter((r, i, all) => all.findIndex(o => o.day === r.day) === i);
    const { res, body } = makeRes();
    await handler(makeReq({ day: '2026-09-20' }), res);
    const actions = body().processed!.map(p => p.action);
    expect(mockedReflect).toHaveBeenCalledTimes(Math.min(MAX_WORK_ITEMS_PER_RUN, reflections.length + 2));
    expect(actions.slice(0, reflections.length).every(a => a === 'done')).toBe(true);
  });

  it('rotates the start of today\'s pass by the budget each day, deterministically', () => {
    const users = ['u-a', 'u-b', 'u-c'];
    // 2026-09-20 is epoch day 20716 → 20716 × 10 % 3 = 1; each day moves it on by 10 ≡ 1 (mod 3).
    expect(rotateForDay(users, '2026-09-20')).toEqual(['u-b', 'u-c', 'u-a']);
    expect(rotateForDay(users, '2026-09-21')).toEqual(['u-c', 'u-a', 'u-b']);
    expect(rotateForDay(users, '2026-09-22')).toEqual(['u-a', 'u-b', 'u-c']);
    expect(rotateForDay(users, '2026-09-20')).toEqual(rotateForDay(users, '2026-09-20'));
    expect(rotateForDay([], '2026-09-20')).toEqual([]);
    // With more athletes than the budget, tomorrow starts exactly where tonight's budget ran out.
    const many = Array.from({ length: MAX_WORK_ITEMS_PER_RUN * 2 + 5 }, (_, i) => `u-${i}`);
    const tonight = rotateForDay(many, '2026-09-20');
    expect(rotateForDay(many, '2026-09-21')[0]).toBe(tonight[MAX_WORK_ITEMS_PER_RUN]);
  });

  it('with more athletes than the budget, tonight\'s deferred athlete leads tomorrow', async () => {
    mockedKey.mockResolvedValue('sk-ant-any');
    profiles = Array.from({ length: MAX_WORK_ITEMS_PER_RUN + 1 }, (_, i) => ({
      id: `u-${String(i).padStart(2, '0')}`, coach_model: null, reflection_opt_in: true,
    }));
    const tonight = makeRes();
    await handler(makeReq({ day: '2026-09-20' }), tonight.res);
    const deferred = tonight.body().processed!.filter(p => p.action === 'deferred').map(p => p.userId);
    expect(deferred).toHaveLength(1);
    mockedReflect.mockClear();
    const tomorrow = makeRes();
    await handler(makeReq({ day: '2026-09-21' }), tomorrow.res);
    expect(mockedReflect.mock.calls[0][1].userId).toBe(deferred[0]);
  });
});
