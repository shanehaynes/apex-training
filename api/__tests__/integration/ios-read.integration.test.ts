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
import coachSummaryHandler from '../../_lib/handlers/coachSummary';
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
        stream: (request: { tools?: unknown }) => (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
          if (!request.tools) {
            // The coach summary passes no tools: prose only, the way the
            // tracker's summary overlay streams it.
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Strong session — ' } };
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a new estimated 1RM on Fixture Press.' } };
            return;
          }
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
// Three one-off events on the same day as the completed occurrence, so the
// Day view fixture has four events (an overflow chip on the month grid) and
// the event sheet has every field it renders: cardio targets, climbing pitches
// and targets, supersets with planned sets. The weekly base is left exactly as
// it was so bootstrap.json / finish.json do not move.
const FIXTURE_DAY = '2026-09-08';
const RUN_ID = `${FX}-run`;
const CRAG_ID = `${FX}-crag`;
const CIRCUIT_ID = `${FX}-circuit`;
const MEAL_IDS = [`${FX}-meal-1`, `${FX}-meal-2`];
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
    await admin.from('workout_events').delete().like('id', `${FX}%`);
    await admin.from('exercise_definitions').delete().eq('id', DEF_ID);
    await admin.from('activity_streams').delete().like('event_id', `${FX}%`);
    await admin.from('meals').delete().in('id', MEAL_IDS);
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
    fail('run', (await admin.from('workout_events').insert({
      id: RUN_ID, user_id: agent.userId, title: 'Fixture Run', subtitle: 'Zone 2', type: 'cardio', sport: 'running',
      date: FIXTURE_DAY, start_time: '06:30', end_time: '07:10', estimated_duration: 40, difficulty: 2,
      description: 'Easy aerobic miles.', location: 'East Rock', tags: ['fixture'],
      cardio_targets: { distance: '5 mi', elevationGain: '800 ft', avgHeartRate: 150 },
      exercises: [{ id: 'fx-run', name: 'Fixture Easy Run', category: 'cardio', duration: '40 min' }],
    })).error);
    fail('crag', (await admin.from('workout_events').insert({
      id: CRAG_ID, user_id: agent.userId, title: 'Fixture Crag Day', type: 'outdoor-climbing', sport: 'climbing',
      date: FIXTURE_DAY, start_time: '09:00', estimated_duration: 240, difficulty: 4,
      description: 'Four pitches, then home.', location: 'Ragged Mountain', tags: ['fixture'],
      climbing_targets: { maxGrade: '5.11a', totalPitches: 4 },
      warmup: [{ id: 'fx-approach', name: 'Fixture Approach Hike', category: 'cardio', duration: '25 min' }],
      exercises: [
        { id: 'fx-p1', name: 'Fixture Arete', category: 'climbing', climbStyle: 'sport', grade: '5.10c', ascentStyle: 'redpoint' },
        { id: 'fx-p2', name: 'Fixture Crack', category: 'climbing', climbStyle: 'trad', grade: '5.9', ascentStyle: 'flash' },
      ],
    })).error);
    fail('circuit', (await admin.from('workout_events').insert({
      id: CIRCUIT_ID, user_id: agent.userId, title: 'Fixture Circuit', type: 'weights',
      date: FIXTURE_DAY, start_time: '12:00', estimated_duration: 45, difficulty: 3,
      description: 'Squat and pull-up superset, then core.', tags: ['fixture'],
      exercises: [
        { id: 'fx-c1', name: 'Fixture Squat', category: 'strength', sets: 3, reps: '5', weight: '185 lb', restPeriod: '90 s', superset: 'A',
          plannedSets: [
            { setNumber: 1, targetWeight: '135 lb', targetReps: '5' },
            { setNumber: 2, targetWeight: '165 lb', targetReps: '5' },
            { setNumber: 3, targetWeight: '185 lb', targetReps: '5' },
          ] },
        { id: 'fx-c2', name: 'Fixture Pull-Up', category: 'strength', sets: 3, reps: '8', superset: 'A', notes: 'Strict.' },
        { id: 'fx-c3', name: 'Fixture Plank', category: 'strength', duration: '60 s' },
      ],
    })).error);
    fail('streams', (await admin.from('activity_streams').insert({
      user_id: agent.userId, event_id: RUN_ID, event_date: FIXTURE_DAY, provider: 'coros', activity_id: `${FX}-act`,
      summary: { sport: 'run', sportLabel: 'Run', startUtc: '2026-09-08T10:30:00Z', durationSec: 2400,
                 distanceMeters: 8046.72, elevationGainMeters: 243.84, avgHr: 150, maxHr: 172, calories: 420, trainingLoad: 88 },
      streams: {
        hr: [[0, 120], [600, 145], [1200, 155], [1800, 160], [2400, 150]],
        gps: [[0, 41.321, -72.904, 30], [600, 41.325, -72.901, 45], [1200, 41.33, -72.899, 80], [1800, 41.326, -72.903, 55], [2400, 41.321, -72.904, 30]],
      },
    })).error);
    fail('meals', (await admin.from('meals').insert([
      { id: MEAL_IDS[0], user_id: agent.userId, title: 'Fixture Oats', date: FIXTURE_DAY, time: '07:15', meal_type: 'breakfast',
        calories: 520, protein_g: 22, carbs_g: 78, fat_total_g: 12 },
      // No stored calories: the server derives them (Atwater), which is the
      // reason the app asks the server rather than adding grams itself.
      { id: MEAL_IDS[1], user_id: agent.userId, title: 'Fixture Chicken Bowl', date: FIXTURE_DAY, time: '12:45', meal_type: 'lunch',
        protein_g: 48, carbs_g: 60, fat_total_g: 18 },
    ])).error);
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

    // A peek (W4) reads the model without starting the session — the native
    // app prefetches today's workouts so one can start offline, and a prefetch
    // must never stamp a started_at nobody chose. Plan and shadows come back;
    // `session` is null; no row is written.
    const peek = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { action: 'bootstrap', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22', peek: true },
    }), peek.res);
    expect(peek.statusCode).toBe(200);
    const peeked = peek.body as { session: unknown; groups: unknown[]; prs: unknown[]; scoreRecord: unknown };
    expect(peeked.session).toBeNull();
    expect(peeked.groups).toHaveLength(1);
    expect(peeked.prs).toEqual([]);
    const { data: noRow } = await getSupabaseAdmin()!
      .from('workout_sessions').select('id').eq('user_id', agent.userId).eq('event_id', TRACKED_OCCURRENCE);
    expect(noRow).toEqual([]);
    const peekOther = makeRes();
    await sessionsHandler(makeReq({
      method: 'POST', token: agent2.token,
      body: { action: 'bootstrap', eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22', peek: true },
    }), peekOther.res);
    expect(peekOther.statusCode).toBe(404);

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
    fixture('bootstrap-peek.json', peek.body);
    fixture('finish.json', finish.body);
  });

  it('coach-summary v2 rebuilds the recap from the saved rows, streams NDJSON text, and persists it', async () => {
    // The session above is finished; the model call is the scripted stream.
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-ant-integration');
    const c = makeRes();
    const chunks: string[] = [];
    (c.res as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    (c.res as unknown as { on: () => unknown }).on = () => c.res;
    await coachSummaryHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { eventId: TRACKED_OCCURRENCE, eventDate: '2026-09-22' },
    }), c.res);
    const events = chunks.join('').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(events.map(e => e.type)).toEqual(['text', 'text', 'done']);

    // Persisted on the session, so reopening the summary is free.
    const { data: row } = await getSupabaseAdmin()!
      .from('workout_sessions').select('coach_summary')
      .eq('user_id', agent.userId).eq('event_id', TRACKED_OCCURRENCE).eq('event_date', '2026-09-22').single();
    expect(row?.coach_summary).toBe('Strong session — a new estimated 1RM on Fixture Press.');

    // A session that never finished is refused, not summarised.
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-ant-integration');
    const early = makeRes();
    await coachSummaryHandler(makeReq({
      method: 'POST', token: agent.token,
      body: { eventId: `${EVENT_ID}__2026-09-29`, eventDate: '2026-09-29' },
    }), early.res);
    expect(early.statusCode).toBe(409);

    fixture('coach-summary.ndjson', chunks.join(''));
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
    type ScheduleBody = { window: unknown; bases: Array<{ id: string }>; occurrences: Array<{ id: string; baseId: string; date: string }>; definitions: Array<{ id: string }>; templates: unknown[] };
    // Sorted: Postgres returns same-day rows in whatever order it likes, and a
    // fixture that reshuffles between runs is a fixture that always "drifts".
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const carve = (body: ScheduleBody) => ({
      window: body.window,
      bases: body.bases.filter(b => b.id.startsWith(FX)).sort(byId),
      occurrences: body.occurrences.filter(o => o.baseId.startsWith(FX))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
      definitions: body.definitions.filter(d => d.id === DEF_ID),
      // Templates are whatever the seed carries; keep the key so the model decodes it.
      templates: [],
    });
    const sched = await schedule(agent.token, { start: '2026-09-01', end: '2026-09-30', include: 'definitions,templates' });
    const carved = carve(sched.body as ScheduleBody);
    // Four bases: the weekly series plus the three one-offs on FIXTURE_DAY.
    expect(carved.bases.map(b => b.id).sort()).toEqual([CIRCUIT_ID, CRAG_ID, RUN_ID, EVENT_ID].sort());
    fixture('schedule.json', carved);

    // Past the series' UNTIL and holding no fixture rows: the empty-state fixture.
    const empty = await schedule(agent.token, { start: '2026-10-28', end: '2026-11-30', include: 'definitions,templates' });
    const carvedEmpty = carve(empty.body as ScheduleBody);
    expect(carvedEmpty.occurrences).toEqual([]);
    fixture('schedule-empty.json', carvedEmpty);

    // The streams row the way the app reads it: the anon client under the
    // user's JWT, so the per-user SELECT policy is what this proves.
    const asAgent = createClient(env.url, env.anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${agent.token}` } },
    });
    const { data: streams, error: streamsError } = await asAgent
      .from('activity_streams').select('provider, summary, streams').like('event_id', `${FX}%`);
    expect(streamsError).toBeNull();
    expect(streams).toHaveLength(1);
    const { data: otherStreams } = await createClient(env.url, env.anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${agent2.token}` } },
    }).from('activity_streams').select('provider').like('event_id', `${FX}%`);
    expect(otherStreams).toEqual([]);
    fixture('activity-streams.json', streams);

    const meals = await query(agent.token, { tool: 'get_meals', args: { start_date: FIXTURE_DAY, end_date: FIXTURE_DAY, include_items: true } });
    expect(meals.statusCode).toBe(200);
    const mealDays = (meals.body as { result: { days: Array<{ meal_count: number; totals: { calories: number } }> } }).result.days;
    expect(mealDays).toHaveLength(1);
    expect(mealDays[0].meal_count).toBe(2);
    // 520 stored + 594 derived (48·4 + 60·4 + 18·9).
    expect(mealDays[0].totals.calories).toBe(1114);
    fixture('query-get_meals.json', meals.body);

    fixture('query-search_exercises.json', (await query(agent.token, { tool: 'search_exercises', args: { query: 'fixture' } })).body);
    fixture('query-get_prs.json', (await query(agent.token, { tool: 'get_prs', args: { exercise_name: 'Fixture Press' } })).body);

    const prof = makeRes();
    await profileHandler(makeReq({ method: 'GET', token: agent.token }), prof.res);
    expect(prof.statusCode).toBe(200);
    fixture('profile.json', prof.body);
  });
});
