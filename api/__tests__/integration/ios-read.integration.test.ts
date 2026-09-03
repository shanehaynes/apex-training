// W0 read foundation against the LOCAL Supabase stack: GET /api/schedule,
// POST /api/query, and the server-built quick-complete — real JWTs, real RLS,
// cross-user scoping. Also the iOS fixture contract: the last test writes (or
// checks) ios/Fixtures/*.json from these very responses, which is what keeps
// the Swift models honest without a TS→Swift codegen pipeline
// (docs/ios/testing-and-ci.md §2).
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Regenerate the fixtures after a deliberate shape change with
//   APEX_LOCAL_SUPABASE=1 APEX_FIXTURES_WRITE=1 vitest run api/__tests__/integration/ios-read

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import scheduleHandler from '../../_lib/handlers/schedule';
import queryHandler from '../../_lib/handlers/query';
import sessionsHandler from '../../_lib/handlers/workoutSessions';
import profileHandler from '../../_lib/handlers/profile';
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

/** Replace volatile values so a fixture is byte-stable across stack resets. */
function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => normalize(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v, k)]));
  }
  if (typeof value === 'string') {
    if (/(_at|At)$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return '<timestamp>';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<uuid>';
  }
  return value;
}

function fixture(name: string, payload: unknown): void {
  const path = join(FIXTURE_DIR, name);
  const text = `${JSON.stringify(normalize(payload), null, 2)}\n`;
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
