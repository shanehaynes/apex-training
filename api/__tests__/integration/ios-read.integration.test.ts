// W0 read foundation + W3 tracker bootstrap against the LOCAL Supabase stack:
// GET /api/schedule, POST /api/query, the server-built quick-complete, and
// the tracker's bootstrap/finish — real JWTs, real RLS,
// cross-user scoping. Also the iOS fixture contract: the last test writes (or
// checks) ios/Fixtures/*.json from these very responses, which is what keeps
// the Swift models honest without a TS→Swift codegen pipeline
// (docs/ios/testing-and-ci.md §2).
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Regenerate the fixtures after a deliberate shape change with
//   APEX_LOCAL_SUPABASE=1 APEX_FIXTURES_WRITE=1 vitest run api/__tests__/integration/ios-read

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import scheduleHandler from '../../_lib/handlers/schedule';
import queryHandler from '../../_lib/handlers/query';
import sessionsHandler from '../../_lib/handlers/workoutSessions';
import profileHandler from '../../_lib/handlers/profile';
import chatHandler from '../../chat';
import coachToolHandler from '../../_lib/handlers/coachTool';
import analyticsComputeHandler from '../../_lib/handlers/analyticsCompute';
import { buildChatContext } from '../../_lib/coach/context';
import { getSupabaseAdmin } from '../../_lib/supabaseAdmin';
import { getAnthropicKey } from '../../_lib/anthropicKey';

// The chat handler needs a key and a model; both are mocked so the context
// builder and the wire framing (labels!) run against REAL data while the
// model call is scripted. Only this file sees these mocks.
vi.mock('../../_lib/anthropicKey.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../_lib/anthropicKey.js')>();
  // Real behaviour by default (the profile fixture reports the true key
  // status); the chat test primes one call with a key.
  return { ...original, getAnthropicKey: vi.fn(original.getAnthropicKey) };
});
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function () {
    return {
      messages: {
        stream: () => (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Clearing it. ' } };
          yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'delete_event' } };
          yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"ios-fixture-weekly__2026-09-29","scope":"instance","date":"2026-09-29"}' } };
          yield { type: 'content_block_stop' };
        })(),
      },
    };
  }),
}));
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;
const WRITE_FIXTURES = !!process.env.APEX_FIXTURES_WRITE;
const FIXTURE_DIR = join(__dirname, '..', '..', '..', 'ios', 'Fixtures');

interface CapturedResponse { statusCode: number; body: unknown; res: VercelResponse }

function makeRes(): CapturedResponse {
  const captured: CapturedResponse = { statusCode: 200, body: undefined, res: undefined as never };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
    send(body: unknown) { captured.body = body; return res; },
    write: () => true,
    end: () => res,
  } as unknown as VercelResponse;
  captured.res = res;
  return captured;
}

function makeReq(opts: { method: string; token?: string; query?: Record<string, string>; body?: unknown }): VercelRequest {
  return {
    method: opts.method,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    query: opts.query ?? {},
    body: opts.body,
    cookies: {},
  } as unknown as VercelRequest;
}

// Fixture ids all share this prefix so the emitter can carve the fixture
// rows out of whatever else the seeded agent user has.
const FX = 'ios-fixture';
const EVENT_ID = `${FX}-weekly`;
const DEF_ID = `${FX}-def`;
const DONE_OCCURRENCE = `${EVENT_ID}__2026-09-08`;
const QUICK_OCCURRENCE = `${EVENT_ID}__2026-09-15`;
const TRACKED_OCCURRENCE = `${EVENT_ID}__2026-09-22`;

/** Replace volatile values so a fixture is byte-stable across stack resets. */
function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => normalize(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v, k)]));
  }
  if (typeof value === 'string') {
    if (/(_at|At)$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return '<timestamp>';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<uuid>';
    // Server-minted ids inside prose (tool_result text, labels).
    return value.replace(/\b(ai|meal)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1-<uuid>');
  }
  return value;
}

function fixture(name: string, payload: unknown): void {
  const path = join(FIXTURE_DIR, name);
  // .ndjson fixtures are the wire bytes themselves; everything else is JSON.
  const text = name.endsWith('.ndjson') ? String(payload) : `${JSON.stringify(normalize(payload), null, 2)}\n`;
  if (WRITE_FIXTURES) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(existsSync(path), `${name} missing — run with APEX_FIXTURES_WRITE=1 to create it`).toBe(true);
  expect(readFileSync(path, 'utf8'), `${name} drifted — re-run with APEX_FIXTURES_WRITE=1 and commit if deliberate`).toBe(text);
}

describe.skipIf(!RUN)('W0 read foundation against the local stack', () => {
  let env: { url: string; anonKey: string; serviceKey: string };
  let agent: { token: string; userId: string };
  let agent2: { token: string; userId: string };
  let admin: SupabaseClient;

  async function signIn(email: string, password: string) {
    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`sign-in failed for ${email}: ${await res.text()}`);
    const data = await res.json() as { access_token: string; user: { id: string } };
    return { token: data.access_token, userId: data.user.id };
  }

  async function cleanup() {
    await admin.from('workout_set_logs').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_cardio_logs').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_sessions').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_completion_log').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_completions').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_events').delete().eq('id', EVENT_ID);
    await admin.from('exercise_definitions').delete().eq('id', DEF_ID);
  }

  beforeAll(async () => {
    env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;
    agent = await signIn('agent@apex.local', 'apex-agent-password');
    agent2 = await signIn('agent2@apex.local', 'apex-agent-password');
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });
    await cleanup();

    const fail = (label: string, error: { message: string } | null) => {
      if (error) throw new Error(`${label}: ${error.message}`);
    };
    fail('definition', (await admin.from('exercise_definitions').insert({
      id: DEF_ID, user_id: agent.userId, canonical_name: 'Fixture Press', category: 'strength',
      aliases: ['fx press'], muscle_groups: ['chest'], equipment: ['barbell'], is_unilateral: false,
    })).error);
    fail('event', (await admin.from('workout_events').insert({
      id: EVENT_ID, user_id: agent.userId, title: 'Fixture Push Day', type: 'weights', date: '2026-09-01',
      start_time: '17:30', end_time: '18:30', estimated_duration: 60, difficulty: 3, description: 'W0 fixture',
      tags: ['fixture'], is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261027',
      exercises: [
        { id: 'fx-press', name: 'fx press', definitionId: DEF_ID, category: 'strength', sets: 2, reps: '5', weight: '100 lb', restPeriod: '2 min' },
        { id: 'fx-row', name: 'Fixture Row', category: 'cardio', duration: '20 min' },
      ],
    })).error);
    fail('completion', (await admin.from('workout_completions').insert({
      user_id: agent.userId, event_id: DONE_OCCURRENCE, event_date: '2026-09-08', event_title: 'Fixture Push Day',
      event_type: 'weights', duration_minutes: 60, is_completed: true, completed_at: '2026-09-08T18:30:00Z',
    })).error);
    fail('set log', (await admin.from('workout_set_logs').insert([
      { user_id: agent.userId, event_id: DONE_OCCURRENCE, event_date: '2026-09-08', section: 'exercise', exercise_id: 'fx-press',
        exercise_name: 'fx press', definition_id: DEF_ID, set_number: 1, actual_weight: '100 lb', actual_reps: '5', is_autofilled: false },
      { user_id: agent.userId, event_id: DONE_OCCURRENCE, event_date: '2026-09-08', section: 'exercise', exercise_id: 'fx-press',
        exercise_name: 'fx press', definition_id: DEF_ID, set_number: 2, actual_weight: '110 lb', actual_reps: '3', is_autofilled: false },
    ])).error);
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
  });

  const schedule = async (token: string, query: Record<string, string>) => {
    const c = makeRes();
    await scheduleHandler(makeReq({ method: 'GET', token, query }), c.res);
    return c;
  };
  const query = async (token: string, body: unknown) => {
    const c = makeRes();
    await queryHandler(makeReq({ method: 'POST', token, body }), c.res);
    return c;
  };

  it('401s without a token', async () => {
    expect((await schedule('', { start: '2026-09-01', end: '2026-09-30' })).statusCode).toBe(401);
    expect((await query('', { tool: 'get_prs', args: { exercise_name: 'x' } })).statusCode).toBe(401);
  });

  it('GET /api/schedule expands the series once and stubs every in-window occurrence, joined to completions', async () => {
    const c = await schedule(agent.token, { start: '2026-09-01', end: '2026-09-30', include: 'definitions' });
    expect(c.statusCode).toBe(200);
    const body = c.body as {
      bases: Array<{ id: string; exercises: Array<{ name: string; definitionId?: string; restPeriod?: string }> }>;
      occurrences: Array<{ id: string; baseId: string; date: string; isCompleted: boolean; completedAt: string | null; startTime: string | null }>;
      definitions: Array<{ id: string; canonicalName: string }>;
    };
    const base = body.bases.find(b => b.id === EVENT_ID)!;
    expect(base).toBeDefined();
    // The library resolved the alias to its canonical name.
    expect(base.exercises[0]).toMatchObject({ name: 'Fixture Press', definitionId: DEF_ID, restPeriod: '2 min' });
    expect(body.bases.filter(b => b.id.startsWith(EVENT_ID))).toHaveLength(1);

    const mine = body.occurrences.filter(o => o.baseId === EVENT_ID);
    expect(mine.map(o => o.date)).toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
    expect(mine[0]).toMatchObject({ id: EVENT_ID, startTime: '17:30', isCompleted: false });
    expect(mine[1]).toMatchObject({ id: DONE_OCCURRENCE, isCompleted: true, completedAt: '2026-09-08T18:30:00+00:00' });
    expect(body.definitions.find(d => d.id === DEF_ID)?.canonicalName).toBe('Fixture Press');
  });

  it('GET /api/schedule never leaks another user\'s events', async () => {
    const c = await schedule(agent2.token, { start: '2026-09-01', end: '2026-09-30' });
    expect(c.statusCode).toBe(200);
    const body = c.body as { bases: Array<{ id: string }>; occurrences: Array<{ baseId: string }> };
    expect(body.bases.some(b => b.id === EVENT_ID)).toBe(false);
    expect(body.occurrences.some(o => o.baseId === EVENT_ID)).toBe(false);
  });

  it('POST /api/query runs registry tools as the JWT user', async () => {
    const search = await query(agent.token, { tool: 'search_exercises', args: { query: 'fixture' } });
    expect(search.statusCode).toBe(200);
    const found = (search.body as { result: { exercises: Array<{ canonical_name: string; last_performed: string | null }> } }).result.exercises;
    expect(found).toEqual([expect.objectContaining({ canonical_name: 'Fixture Press', last_performed: '2026-09-08' })]);

    const prs = await query(agent.token, { tool: 'get_prs', args: { exercise_name: 'fx press' } });
    expect(prs.statusCode).toBe(200);
    expect(JSON.stringify(prs.body)).toContain('Fixture Press');

    const other = await query(agent2.token, { tool: 'search_exercises', args: { query: 'fixture' } });
    expect((other.body as { result: { exercises: unknown[] } }).result.exercises).toEqual([]);

    const bad = await query(agent.token, { tool: 'get_exercise_history', args: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('quick-complete with no rows builds them from the plan and stamps the recommended duration', async () => {
    const c = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { action: 'quick-complete', eventId: QUICK_OCCURRENCE, eventDate: '2026-09-15' },
    }), c.res);
    expect(c.statusCode).toBe(200);

    const { data: sets } = await admin.from('workout_set_logs').select('set_number, actual_weight, actual_reps, is_autofilled, exercise_name')
      .eq('event_id', QUICK_OCCURRENCE).order('set_number');
    expect(sets).toEqual([
      { set_number: 1, actual_weight: '100 lb', actual_reps: '5', is_autofilled: true, exercise_name: 'Fixture Press' },
      { set_number: 2, actual_weight: '100 lb', actual_reps: '5', is_autofilled: true, exercise_name: 'Fixture Press' },
    ]);
    const { data: cardio } = await admin.from('workout_cardio_logs').select('exercise_id, duration_minutes, is_autofilled').eq('event_id', QUICK_OCCURRENCE);
    expect(cardio).toEqual([{ exercise_id: 'fx-row', duration_minutes: 20, is_autofilled: true }]);
    const { data: session } = await admin.from('workout_sessions').select('total_duration_seconds, finished_at').eq('event_id', QUICK_OCCURRENCE).single();
    expect(session!.total_duration_seconds).toBe(3600);
    expect(session!.finished_at).not.toBeNull();

    // Another user cannot quick-complete it: the event lookup is user-scoped.
    const other = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent2.token,
      body: { action: 'quick-complete', eventId: QUICK_OCCURRENCE, eventDate: '2026-09-15' },
    }), other.res);
    expect(other.statusCode).toBe(404);
  });

  it('bootstrap resolves the plan with last-session shadows; finish detects PRs and returns the recap', async () => {
    // A client-stamped start an hour ago (the offline-flush path); the finish
    // below lands 30 minutes after it, pinning the duration so the fixture is
    // stable across runs.
    const startedAt = new Date(Date.now() - 3600_000).toISOString();
    const boot = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { action: 'bootstrap', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22', startedAt },
    }), boot.res);
    expect(boot.statusCode).toBe(200);
    const model = boot.body as {
      session: { started_at: string; finished_at: string | null };
      groups: Array<{ section: string; exercises: Array<{ exercise: { name: string }; isCardio: boolean; sets: Array<{ setNumber: number; shadow: { weight: string; reps: string } | null; isLogged: boolean }> }> }>;
      scored: boolean; prs: unknown[];
    };
    expect(model.session.finished_at).toBeNull();
    expect(model.scored).toBe(false);
    const press = model.groups[0].exercises.find(e => e.exercise.name === 'Fixture Press')!;
    // Shadows come from the 09-08 real logs; the 09-15 quick-complete rows are autofilled and ignored.
    expect(press.sets.map(s => [s.setNumber, s.isLogged, s.shadow])).toEqual([
      [1, false, { weight: '100 lb', reps: '5', duration: '' }],
      [2, false, { weight: '110 lb', reps: '3', duration: '' }],
    ]);
    expect(model.groups[0].exercises.find(e => e.isCardio)?.exercise.name).toBe('Fixture Row');

    // Log one heavier set, then finish: est. 1RM 120×3 (132) beats 110×3 (121).
    const save = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { action: 'save', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22', setLogs: [{
        event_id: TRACKED_OCCURRENCE, event_date: '2026-09-22', section: 'exercise', exercise_id: 'fx-press',
        exercise_name: 'Fixture Press', definition_id: DEF_ID, set_number: 1,
        planned_weight: '100 lb', planned_reps: '5', planned_duration: null,
        actual_weight: '120 lb', actual_reps: '3', actual_duration: null, is_autofilled: false,
      }] },
    }), save.res);
    expect(save.statusCode).toBe(200);

    expect(model.session.started_at.slice(0, 19)).toBe(startedAt.slice(0, 19));
    const finishedAt = new Date(Date.parse(startedAt) + 1800_000).toISOString();
    const finish = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { action: 'finish', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22', autofillRows: [], finishedAt },
    }), finish.res);
    expect(finish.statusCode).toBe(200);
    const done = finish.body as { prs: Array<{ kind: string; exerciseName: string; description: string }>; recap: string; totalDurationSeconds: number };
    expect(done.totalDurationSeconds).toBe(1800);
    expect(done.recap).toContain('Duration: 30 min');
    expect(done.prs).toEqual([expect.objectContaining({ kind: 'oneRM', exerciseName: 'Fixture Press' })]);
    expect(done.prs[0].description).toContain('up from 121');
    expect(done.recap).toContain('Fixture Press: 120 lb × 3');
    expect(done.recap).toContain('PERSONAL RECORDS');

    // Re-bootstrapping a finished session reports the same records.
    const again = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { action: 'bootstrap', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22' },
    }), again.res);
    const reopened = again.body as { session: { finished_at: string | null }; prs: Array<{ kind: string }> };
    expect(reopened.session.finished_at).not.toBeNull();
    expect(reopened.prs.map(p => p.kind)).toEqual(['oneRM']);

    // Another user sees nothing of it.
    const other = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent2.token,
      body: { action: 'bootstrap', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22' },
    }), other.res);
    expect(other.statusCode).toBe(404);

    fixture('bootstrap.json', again.body);
    fixture('finish.json', finish.body);
  });

  it('chat v2: the server builds the prompt from the caller\'s data and labels tool calls', async () => {
    // The context builder against real rows: today = the tracked occurrence's date.
    const admin2 = getSupabaseAdmin()!;
    const { system } = await buildChatContext(admin2, agent.userId, 'chat', '2026-09-22');
    expect(system).toContain(`[${TRACKED_OCCURRENCE}] Fixture Push Day (60 min) at 17:30`);
    expect(system).toContain('Fixture Press');
    expect(system).toMatch(/LAST 4 WEEKS: \d+\/\d+ completed/);
    // Another user's prompt knows nothing of it.
    const other = await buildChatContext(admin2, agent2.userId, 'chat', '2026-09-22');
    expect(other.system).not.toContain('Fixture Push Day');

    // The handler end to end: v2 body → NDJSON with a labelled tool_use.
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-ant-integration');
    const c = makeRes();
    const chunks: string[] = [];
    (c.res as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    (c.res as unknown as { on: () => unknown }).on = () => c.res;
    await chatHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { mode: 'chat', today: '2026-09-22', withTools: true, messages: [{ role: 'user', content: 'skip next week' }] },
    }), c.res);
    const events = chunks.join('').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(events.map(e => e.type)).toEqual(['text', 'tool_use', 'done']);
    expect(events[1]).toMatchObject({
      name: 'delete_event',
      label: 'Delete: Fixture Push Day · 2026-09-29 (this instance)',
    });
    fixture('chat-stream.ndjson', chunks.join(''));
  });

  it('coach-tool: a recorded eval tool call executes on the server with ai attribution; other users cannot reach it', async () => {
    // The create_event input a real eval run produced — the same executor now
    // runs here against the service-role client.
    const transcript = JSON.parse(readFileSync(
      join(__dirname, '..', '..', '..', 'evals', 'results', 'transcripts', '2026-08-01T04-50-11-458Z__claude-opus-4-8', 'postop-knee-load-cap.json'), 'utf8',
    )) as unknown;
    const findInput = (node: unknown): Record<string, unknown> | null => {
      if (Array.isArray(node)) { for (const n of node) { const r = findInput(n); if (r) return r; } return null; }
      if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (o.name === 'create_event' && o.input && typeof o.input === 'object') return o.input as Record<string, unknown>;
        for (const v of Object.values(o)) { const r = findInput(v); if (r) return r; }
      }
      return null;
    };
    const input = findInput(transcript)!;
    expect(input.title).toBeTruthy();

    const before = new Set(((await admin.from('exercise_definitions').select('id').eq('user_id', agent.userId)).data ?? []).map(r => r.id as string));
    const c = makeRes();
    await coachToolHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { toolUseId: 'tu_eval', name: 'create_event', input, today: '2026-08-06' },
    }), c.res);
    expect(c.statusCode).toBe(200);
    const out = c.body as { ok: boolean; resultText: string };
    expect(out.ok).toBe(true);
    expect(out.resultText).toContain('Created');
    const createdId = /\[(ai-[0-9a-f-]{36})\]/.exec(out.resultText)?.[1] ?? null;
    expect(createdId).not.toBeNull();

    try {
      const { data: row } = await admin.from('workout_events').select('title, user_id, exercises').eq('id', createdId!).single();
      expect(row!.title).toBe(input.title);
      expect(row!.user_id).toBe(agent.userId);
      expect((row!.exercises as Array<{ name: string }>).map(e => e.name)).toContain('Back Squat');
      // Attribution is stamped by the server, not declared by the caller.
      const { data: log } = await admin.from('event_mutations_log').select('triggered_by, operation').eq('event_id', createdId!).single();
      expect(log).toEqual({ triggered_by: 'ai', operation: 'create' });

      // Another user's coach cannot touch it: the executor reports not found, the row stays.
      const other = makeRes();
      await coachToolHandler(makeReq({
        method: 'POST', token: agent2.token,
        body: { name: 'delete_event', input: { event_id: createdId, scope: 'all' }, today: '2026-08-06' },
      }), other.res);
      expect(other.statusCode).toBe(200);
      expect((other.body as { resultText: string }).resultText).not.toContain('Deleted');
      expect((await admin.from('workout_events').select('id').eq('id', createdId!)).data).toHaveLength(1);

      fixture('coach-tool.json', out);
    } finally {
      await admin.from('event_mutations_log').delete().eq('event_id', createdId!);
      await admin.from('workout_events').delete().eq('id', createdId!);
      const after = ((await admin.from('exercise_definitions').select('id').eq('user_id', agent.userId)).data ?? []).map(r => r.id as string);
      const created = after.filter(id => !before.has(id));
      if (created.length) {
        await admin.from('definition_mutations_log').delete().in('definition_id', created);
        await admin.from('exercise_definitions').delete().in('id', created);
      }
    }
  });

  it('analytics-compute: the engine runs over the caller\'s rows and answers index-aligned TileData', async () => {
    const window = { kind: 'fixed', startDate: '2026-09-01', endDateExclusive: '2026-10-01' };
    const specs = [
      { version: 1, title: 'Sessions', chartType: 'kpi', range: window, bucket: 'total', series: [{ id: 's1', measure: 'session-count' }] },
      // No exercise filter: the 09-08 rows carry the alias spelling ('fx press')
      // and the engine filters on the logged name, browser and server alike.
      { version: 1, title: 'Tonnage', chartType: 'bar', range: window, bucket: 'week', series: [{ id: 's1', measure: 'tonnage' }] },
      { version: 1, title: 'broken', chartType: 'line', range: window, bucket: 'week', series: [{ id: 's1', measure: 'no-such-measure' }] },
    ];
    const c = makeRes();
    await analyticsComputeHandler(makeReq({ method: 'POST', token: agent.token, body: { specs, today: '2026-09-22' } }), c.res);
    expect(c.statusCode).toBe(200);
    const { tiles } = c.body as { tiles: Array<{ ok: boolean; data?: { series: Array<{ points: Array<number | null> }> }; problem?: string }> };
    expect(tiles).toHaveLength(3);
    // One completed fixture occurrence in September (09-08); the quick-complete and
    // the tracked finish do not write completions.
    expect(tiles[0].ok).toBe(true);
    expect(tiles[0].data!.series[0].points).toEqual([1]);
    // Tonnage from the real logs: 100×5 + 110×3 (09-08) and 120×3 (09-22); autofilled rows excluded.
    expect(tiles[1].ok).toBe(true);
    const weekly = tiles[1].data!.series[0].points.map(p => p ?? 0);
    expect(weekly.reduce((a, b) => a + b, 0)).toBe(1190);
    expect(tiles[2].ok).toBe(false);
    expect(tiles[2].problem).toBeTruthy();

    // Another user's tiles never see these rows.
    const other = makeRes();
    await analyticsComputeHandler(makeReq({ method: 'POST', token: agent2.token, body: { specs: [specs[1]], today: '2026-09-22' } }), other.res);
    expect(other.statusCode).toBe(200);
    const otherWeekly = (other.body as { tiles: Array<{ data?: { series: Array<{ points: Array<number | null> }> } }> }).tiles[0].data?.series[0]?.points.map(p => p ?? 0) ?? [];
    expect(otherWeekly.reduce((a, b) => a + b, 0)).toBe(0);

    fixture('analytics-compute.json', c.body);
  });

  it('emits (or checks) the iOS fixture contract from real responses', async () => {
    const sched = await schedule(agent.token, { start: '2026-09-01', end: '2026-09-30', include: 'definitions,templates' });
    const body = sched.body as { window: unknown; bases: Array<{ id: string }>; occurrences: Array<{ baseId: string }>; definitions: Array<{ id: string }>; templates: unknown[] };
    fixture('schedule.json', {
      window: body.window,
      bases: body.bases.filter(b => b.id === EVENT_ID),
      occurrences: body.occurrences.filter(o => o.baseId === EVENT_ID),
      definitions: body.definitions.filter(d => d.id === DEF_ID),
      // Templates are whatever the seed carries; keep the key so the model decodes it.
      templates: [],
    });

    fixture('query-search_exercises.json', (await query(agent.token, { tool: 'search_exercises', args: { query: 'fixture' } })).body);
    fixture('query-get_prs.json', (await query(agent.token, { tool: 'get_prs', args: { exercise_name: 'Fixture Press' } })).body);

    const prof = makeRes();
    await profileHandler(makeReq({ method: 'GET', token: agent.token }), prof.res);
    expect(prof.statusCode).toBe(200);
    fixture('profile.json', prof.body);
  });
});
