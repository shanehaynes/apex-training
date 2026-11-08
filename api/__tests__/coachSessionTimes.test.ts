import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachTool';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { MCP_WRITE_TOOLS } from '../_lib/mcp/writeTools';

// docs/specs/coach-session-times: a confirmed edit_session_times through
// POST /api/coach-tool, with the real deps (api/_lib/coach/toolDeps.ts), the
// real executor and the real applyEditTimes, over a fake service-role client
// that records every call. Only the schedule/meal context and auth are stubbed.

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));
vi.mock('../_lib/mcp/data.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../_lib/mcp/data.js')>()),
  fetchExpandedSchedule: vi.fn(async () => ({ occurrences: [], definitions: new Map() })),
}));
vi.mock('../_lib/trackerSession.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../_lib/trackerSession.js')>()),
  loadMealsForDate: vi.fn(async () => []),
}));

interface Call {
  table: string;
  op: 'select' | 'update' | 'insert';
  filters: Array<[string, string, unknown]>;
  payload?: Record<string, unknown>;
}

interface SessionRow {
  event_id: string;
  event_date: string;
  started_at: string;
  finished_at: string | null;
  total_duration_seconds: number | null;
}

let calls: Call[];
let sessions: SessionRow[];
let handLoggedSets: number;
let syncedImports: number;

function filterValue(call: Call, column: string): unknown {
  return call.filters.find(([, c]) => c === column)?.[2];
}

function respond(call: Call): Record<string, unknown> {
  if (call.op !== 'select') return { data: null, error: null };
  switch (call.table) {
    case 'workout_sessions': {
      const date = filterValue(call, 'event_date');
      const ids = call.filters.find(([op]) => op === 'in')?.[2] as string[] | undefined;
      if (ids) return { data: sessions.filter(s => s.event_date === date && ids.includes(s.event_id)), error: null };
      const row = sessions.find(s => s.event_date === date && s.event_id === filterValue(call, 'event_id'));
      return { data: row ? { finished_at: row.finished_at } : null, error: null };
    }
    case 'workout_events':
      return { data: { title: 'Nightly Stretch — Lower' }, error: null };
    case 'workout_set_logs':
      return { count: handLoggedSets, error: null };
    case 'workout_cardio_logs':
      return { count: 0, error: null };
    case 'provider_activity_imports':
      return { count: syncedImports, error: null };
    default:
      return { data: null, error: null };
  }
}

function makeAdmin() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        update: (payload: Record<string, unknown>) => { call.op = 'update'; call.payload = payload; return chain; },
        insert: (payload: Record<string, unknown>) => { call.op = 'insert'; call.payload = payload; return chain; },
        eq: (c: string, v: unknown) => { call.filters.push(['eq', c, v]); return chain; },
        neq: (c: string, v: unknown) => { call.filters.push(['neq', c, v]); return chain; },
        in: (c: string, v: unknown) => { call.filters.push(['in', c, v]); return chain; },
        maybeSingle: async () => respond(call),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(respond(call)).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function post(input: Record<string, unknown>) {
  let payload: unknown;
  let code: number | null = null;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  const req = { method: 'POST', headers: {}, query: {}, body: { name: 'edit_session_times', input, today: '2026-11-08' } } as unknown as VercelRequest;
  return handler(req, res).then(() => ({ status: code, body: payload as { ok?: boolean; resultText?: string } }));
}

const writes = (table: string) => calls.filter(c => c.table === table && c.op !== 'select');

const RUNAWAY: SessionRow = {
  event_id: 'ext-2026-09-01-stretch',
  event_date: '2026-09-01',
  started_at: '2026-09-02T01:14:00+00:00',
  finished_at: '2026-09-21T15:18:15+00:00',
  total_duration_seconds: 1_695_855,
};

beforeEach(() => {
  calls = [];
  sessions = [{ ...RUNAWAY }];
  handLoggedSets = 4;
  syncedImports = 0;
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
});

describe('edit_session_times through POST /api/coach-tool', () => {
  it('rewrites the session and the completion minutes through applyEditTimes (R1)', async () => {
    const { status, body } = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', duration_minutes: 16 });
    expect(status).toBe(200);
    expect(body.resultText).toContain('16 min (was 28,264 min)');

    const [session] = writes('workout_sessions');
    expect(session.payload).toMatchObject({
      started_at: '2026-09-02T01:14:00.000Z',
      finished_at: '2026-09-02T01:30:00.000Z',
      total_duration_seconds: 960,
    });
    expect(session.filters).toEqual(expect.arrayContaining([
      ['eq', 'user_id', 'user-123'], ['eq', 'event_id', 'ext-2026-09-01-stretch'], ['eq', 'event_date', '2026-09-01'],
    ]));
    const [completion] = writes('workout_completions');
    expect(completion.payload).toMatchObject({ duration_minutes: 16 });
  });

  it('logs the edit as an ai update with the before and after times (R6)', async () => {
    await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', finished_at: '2026-09-01T21:30:00-04:00' });
    const [log] = writes('event_mutations_log');
    expect(log.op).toBe('insert');
    expect(log.payload).toEqual({
      user_id: 'user-123',
      operation: 'update',
      event_id: 'ext-2026-09-01-stretch',
      event_title: 'Nightly Stretch — Lower',
      event_date: '2026-09-01',
      triggered_by: 'ai',
      diff: {
        session_times: {
          before: { started_at: RUNAWAY.started_at, finished_at: RUNAWAY.finished_at, total_duration_seconds: 1_695_855 },
          after: { started_at: '2026-09-02T01:14:00.000Z', finished_at: '2026-09-02T01:30:00.000Z', total_duration_seconds: 960 },
        },
      },
    });
  });

  it('reads the recorded session for this user only, and prefers the exact id over the occurrence id (R8)', async () => {
    sessions = [{ ...RUNAWAY, event_id: 'evt-x' }, { ...RUNAWAY, event_id: 'evt-x__2026-09-01' }];
    await post({ event_id: 'evt-x', date: '2026-09-01', duration_minutes: 16 });
    const read = calls.find(c => c.table === 'workout_sessions' && c.filters.some(([op]) => op === 'in'))!;
    expect(read.filters).toContainEqual(['eq', 'user_id', 'user-123']);
    expect(read.filters).toContainEqual(['in', 'event_id', ['evt-x', 'evt-x__2026-09-01']]);
    expect(writes('workout_sessions')[0].filters).toContainEqual(['eq', 'event_id', 'evt-x']);
  });

  it('finds a recurring occurrence\'s session from its base id and the date, and logs the base id (R8)', async () => {
    sessions = [{ ...RUNAWAY, event_id: 'evt-stretch__2026-09-01' }];
    const { body } = await post({ event_id: 'evt-stretch', date: '2026-09-01', duration_minutes: 16 });
    expect(body.resultText).toContain('[evt-stretch__2026-09-01]');
    expect(writes('workout_sessions')[0].filters).toContainEqual(['eq', 'event_id', 'evt-stretch__2026-09-01']);
    expect(writes('event_mutations_log')[0].payload).toMatchObject({ event_id: 'evt-stretch' });
  });

  it('passes applyEditTimes\'s refusals through and writes nothing (R4)', async () => {
    sessions = [{ ...RUNAWAY, finished_at: null, total_duration_seconds: null }];
    const running = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', duration_minutes: 16 });
    expect(running.body.resultText).toBe('Could not change the times: Times can be edited once the workout is finished. Nothing was changed.');

    sessions = [{ ...RUNAWAY }];
    handLoggedSets = 0;
    const untracked = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', duration_minutes: 16 });
    expect(untracked.body.resultText).toMatch(/^Could not change the times: This workout was marked complete, not tracked/);

    handLoggedSets = 4;
    syncedImports = 1;
    const synced = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', duration_minutes: 16 });
    expect(synced.body.resultText).toMatch(/^Could not change the times: This workout’s time came from a synced activity/);

    syncedImports = 0;
    const early = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', started_at: '2026-08-30T12:00:00Z', duration_minutes: 16 });
    expect(early.body.resultText).toBe('Could not change the times: The start must be no earlier than the day before the workout. Nothing was changed.');

    const future = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', finished_at: '2099-01-01T00:00:00Z' });
    expect(future.body.resultText).toBe('Could not change the times: The finish cannot be in the future. Nothing was changed.');

    expect(writes('workout_sessions')).toHaveLength(0);
    expect(writes('workout_completions')).toHaveLength(0);
    expect(writes('event_mutations_log')).toHaveLength(0);
  });

  it('answers a workout with no tracked session without writing (R3)', async () => {
    sessions = [];
    const { body } = await post({ event_id: 'ext-2026-09-01-stretch', date: '2026-09-01', duration_minutes: 16 });
    expect(body.resultText).toMatch(/^No tracked session for "ext-2026-09-01-stretch" on 2026-09-01/);
    expect(calls.filter(c => c.op !== 'select')).toHaveLength(0);
  });
});

describe('edit_session_times on the MCP connector (R9)', () => {
  it('is a write tool with the card-only title cut and the id and date required', () => {
    const tool = MCP_WRITE_TOOLS.find(t => t.name === 'edit_session_times');
    expect(tool?.access).toBe('write');
    const schema = tool!.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['date', 'duration_minutes', 'event_id', 'finished_at', 'started_at', 'today']);
    expect(schema.required).toEqual(['event_id', 'date']);
    expect(tool!.description).not.toContain('card');
  });
});
