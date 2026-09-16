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
import analyticsTilesHandler from '../../_lib/handlers/analyticsTiles';
import workoutDraftHandler from '../../_lib/handlers/workoutDraft';
import mutationsLogHandler from '../../_lib/handlers/mutationsLog';
import mcpTokensHandler from '../../_lib/handlers/mcpTokens';
import blockCycleHandler from '../../_lib/handlers/blockCycle';
import { handleTrainingBlocks } from '../../_lib/trainingBlocks';
import { handleMealFavorites } from '../../_lib/mealFavorites';
import { generateCycle, type CycleSpec } from '../../../src/lib/blocks/cadence';
import { derivedCalories } from '../../../src/lib/nutrition/mapping';
import { emptyDraft } from '../../../src/lib/builder/draft';
import { emptyChartDraft } from '../../../src/lib/analytics/draft';
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
          if ((request.tools as Array<{ name: string }>).some(t => t.name === 'update_chart_draft')) {
            // Analytics mode: the single chart-draft tool, no label (W9).
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Configuring it. ' } };
            yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_fixture_chart', name: 'update_chart_draft' } };
            yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":"Fixture weekly tonnage","chart_type":"bar","bucket":"week","series":[{"id":"s1","measure":"tonnage"}]}' } };
            yield { type: 'content_block_stop' };
            return;
          }
          if ((request.tools as Array<{ name: string }>).some(t => t.name === 'update_workout_draft')) {
            // Builder mode: the single draft tool, no label (W7).
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Adding it. ' } };
            yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_fixture_draft', name: 'update_workout_draft' } };
            yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"exercises":[{"name":"fx press","sets":3,"reps":"8"}]}' } };
            yield { type: 'content_block_stop' };
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
// W11: preview/apply reach a real watch API, so the COROS client is stubbed
// the way provider-sync.integration.test.ts stubs it — everything below the
// client (sport mapping, local-date placement, matching, the writes) is real.
// Two activities: a trail run that matches a planned event (a FILL, the case
// the confirmation sheet exists for) and a ride with nothing planned (a
// CREATE, which needs no confirmation).
// vi.hoisted because the mock factory runs before this file's own consts are
// initialised; the test body reads the same values back.
const SYNC = vi.hoisted(() => ({
  runUtc: '2026-09-09T14:05:00Z',
  rideUtc: '2026-09-09T22:40:00Z',
  runId: 'ios-fixture-run-1',
  rideId: 'ios-fixture-ride-1',
}));

vi.mock('../../_lib/providers/coros/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../_lib/providers/coros/client.js')>();
  class StubCorosClient {
    async fetchRecentActivities() {
      return [
        {
          provider: 'coros' as const, activityId: SYNC.runId, sport: 102,
          startUtc: SYNC.runUtc, durationSec: 2820,
          distanceMeters: 8368.6, elevationGainMeters: 250,
          avgHr: 152, maxHr: 176, calories: 512,
          summaryExtras: { trainingLoad: 87 },
          streams: { hr: [[0, 120], [30, 140], [60, 150]] as [number, number][] },
        },
        {
          provider: 'coros' as const, activityId: SYNC.rideId, sport: 200,
          startUtc: SYNC.rideUtc, durationSec: 5400,
          distanceMeters: 30000, avgHr: 138,
          summaryExtras: {},
        },
      ];
    }
    async fetchActivityDetail() { return null; }
  }
  return { ...original, CorosClient: StubCorosClient };
});

// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';

// Imported AFTER the mock above so providers/sync.ts binds the stub client.
const { default: providerSyncHandler } = await import('../../_lib/handlers/providerSync');

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
const TEMPLATE_ID = `${FX}-template`;
const TEMPLATE_TITLE = 'Fixture Template Push';
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
// W9: the seeded dashboard. Fixed windows (a rolling range moves with
// `today`), full-height rows in y order so the phone's list matches the grid.
const CLIMB_DEF_ID = `${FX}-def-climb`;
const TILE_PREFIX = `${FX}-tile-`;
const TILE_WINDOW = { kind: 'fixed', startDate: '2026-09-01', endDateExclusive: '2026-10-01' };
const TILE_SPECS: Array<{ id: string; spec: Record<string, unknown> }> = [
  { id: `${TILE_PREFIX}sessions`, spec: { version: 1, title: 'Sessions', chartType: 'kpi', range: TILE_WINDOW, bucket: 'total', series: [{ id: 's1', measure: 'session-count' }] } },
  // Filtered on the canonical name while the 09-08 rows carry the alias
  // spelling ('fx press'): the engine resolves filter values and row names
  // alike through the alias index the loader supplies (#101), so the tile
  // counts every press set rather than only the one logged after the rename.
  { id: `${TILE_PREFIX}tonnage`, spec: { version: 1, title: 'Tonnage', chartType: 'bar', range: TILE_WINDOW, bucket: 'week', series: [{ id: 's1', measure: 'tonnage', filters: { exerciseNames: ['Fixture Press'] } }] } },
  { id: `${TILE_PREFIX}time`, spec: { version: 1, title: 'Training time by type', chartType: 'stacked-bar', range: TILE_WINDOW, bucket: 'week', series: [{ id: 's1', measure: 'training-time', groupBy: 'event-type' }] } },
  { id: `${TILE_PREFIX}grade`, spec: { version: 1, title: 'Max grade', chartType: 'table', range: TILE_WINDOW, bucket: 'iso-month', series: [{ id: 's1', measure: 'max-grade', filters: { gradeScale: 'yds' } }] } },
  { id: `${TILE_PREFIX}hr`, spec: { version: 1, title: 'Avg heart rate', chartType: 'line', range: TILE_WINDOW, bucket: 'week', series: [{ id: 's1', measure: 'avg-hr' }] } },
  { id: `${TILE_PREFIX}distance`, spec: { version: 1, title: 'Distance', chartType: 'area', range: TILE_WINDOW, bucket: 'week', series: [{ id: 's1', measure: 'distance' }] } },
];

// W11 integration surfaces (provider connection, MCP tokens, mutations log)
// are all PER-USER SINGLETONS or unprefixed feeds, and agent@apex.local's are
// already owned by other files in this directory — provider-sync's connection
// row, mcp's tokens — which vitest runs in parallel with this one. So the You
// tab's fixtures are emitted for agent2, whose only other job here is proving
// cross-user isolation. provider-cron.integration.test.ts makes the same move
// for the same reason.
const SYNC_TZ = 'America/Los_Angeles';
const PLANNED_RUN_ID = `${FX}-planned-run`;
const TOKEN_NAME = `${FX} laptop`;
const CONNECTED_APP_NAME = `${FX} Claude Desktop`;
const CONNECTED_APP_CLIENT = `${FX}-client-1`;
/** Titles the mutations-log fixture is carved out by. */
const LOG_EVENT_TITLE = 'Fixture Push Day';
const LOG_DEF_NAME = 'Fixture Press';
const LOG_BLOCK_NAME = 'Fixture Base Block';
const LOG_OBJECTIVE_NAME = 'Fixture Spring Objective';
// W10: blocks and objectives are keyed by server uuids, so they are seeded on
// agent, carved by name, and their ids rewritten to these before a fixture is
// written — normalize() collapses every uuid to the one literal `<uuid>`,
// which would leave two blocks sharing an id in the Swift list.
const OBJECTIVE_NAME = LOG_OBJECTIVE_NAME;
const BASE_BLOCK_NAME = LOG_BLOCK_NAME;
const SPRING_BLOCK_NAME = 'Fixture Spring Block';
const STABLE_IDS = { objective: `${FX}-objective-1`, base: `${FX}-block-base`, spring: `${FX}-block-spring` };
const FAVORITE_ID = `${FX}-fav-1`;

/** Replace volatile values so a fixture is byte-stable across stack resets. */
function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => normalize(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v, k)]));
  }
  if (typeof value === 'string') {
    if (/(_at|At)$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return '<timestamp>';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<uuid>';
    // A live credential, not a volatile id: POST /api/mcp-tokens reveals the
    // plaintext PAT exactly once, and it must never reach a committed file.
    if (key === 'token') return '<token>';
    // The displayed tail of a token minted by this very run — as volatile as
    // a uuid, and a fixture that baked one in would fail the drift check on
    // the next run rather than on a real shape change.
    if (key === 'token_last4') return '<last4>';
    return value
      // A uuid carried INSIDE a string — the calendar feed URL embeds the
      // profile's ics_token, and the bare-uuid rule above only fires on a
      // string that is nothing else. Committing that token would publish a
      // working feed URL for the fixture user.
      .replace(/([?&]token=)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1<uuid>')
      // Server-minted ids inside prose (tool_result text, labels).
      .replace(/\b(ai|meal)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1-<uuid>');
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
  /** Server-minted uuid → the stable id the fixture carries (W10). */
  const seededIds = new Map<string, string>();
  const realId = (stable: string) => [...seededIds].find(([, s]) => s === stable)![0];

  /** Rewrite every seeded uuid in a payload to its stable id, before normalize(). */
  function stabilize<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      }
      return typeof v === 'string' && seededIds.has(v) ? seededIds.get(v) : v;
    };
    return walk(value) as T;
  }

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
    await admin.from('workout_set_logs').delete().like('event_id', `${FX}%`);
    await admin.from('workout_cardio_logs').delete().like('event_id', `${FX}%`);
    await admin.from('analytics_tiles').delete().like('id', `${FX}%`);
    await admin.from('workout_sessions').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_completion_log').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('workout_completions').delete().like('event_id', `${EVENT_ID}%`);
    await admin.from('recurring_exceptions').delete().like('event_id', `${FX}%`);
    await admin.from('workout_events').delete().like('id', `${FX}%`);
    await admin.from('workout_templates').delete().like('id', `${FX}%`);
    await admin.from('exercise_definitions').delete().like('id', `${FX}%`);
    await admin.from('activity_streams').delete().like('event_id', `${FX}%`);
    await admin.from('meals').delete().in('id', MEAL_IDS);
    // W10 (agent's side). Blocks before objectives (the FK), and the cycle
    // the preview test commits is named 'Fixture Cycle …', so the LIKE takes
    // it with the seeded pair.
    await admin.from('meal_favorites').delete().like('id', `${FX}%`);
    await admin.from('training_blocks').delete().eq('user_id', agent.userId).like('name', 'Fixture%');
    await admin.from('objectives').delete().eq('user_id', agent.userId).like('name', 'Fixture%');
    await admin.from('block_mutations_log').delete().eq('user_id', agent.userId).like('resource_name', 'Fixture%');

    // W11 (agent2's side). The provider rows are a per-user singleton, and
    // apply writes events keyed `coros-<activityId>` rather than FX-prefixed
    // ones, so they are named rather than matched.
    await admin.from('provider_connections').delete().eq('user_id', agent2.userId).eq('provider', 'coros');
    await admin.from('provider_activity_imports').delete().eq('user_id', agent2.userId);
    for (const id of [`coros-${SYNC.runId}`, `coros-${SYNC.rideId}`]) {
      await admin.from('workout_completions').delete().eq('event_id', id);
      await admin.from('workout_sessions').delete().eq('event_id', id);
      await admin.from('workout_cardio_logs').delete().eq('event_id', id);
      await admin.from('activity_streams').delete().eq('event_id', id);
      await admin.from('workout_events').delete().eq('id', id);
    }
    await admin.from('workout_completions').delete().eq('event_id', PLANNED_RUN_ID);
    await admin.from('workout_sessions').delete().eq('event_id', PLANNED_RUN_ID);
    await admin.from('workout_cardio_logs').delete().eq('event_id', PLANNED_RUN_ID);
    await admin.from('activity_streams').delete().eq('event_id', PLANNED_RUN_ID);
    await admin.from('mcp_tokens').delete().eq('user_id', agent2.userId);
    await admin.from('event_mutations_log').delete().eq('user_id', agent2.userId);
    await admin.from('definition_mutations_log').delete().eq('user_id', agent2.userId);
    await admin.from('block_mutations_log').delete().eq('user_id', agent2.userId);

    // Throttling state outlives the rows. One pass through this file spends
    // several calls from the seeded users' `summary` bucket (10 per hour) and
    // dozens from `writes` and `providerSync`, so a third or fourth run inside
    // the same hour starts getting 429s — which surface as a handler that
    // writes nothing, not as an error that names the cause. Costs CI nothing
    // (it builds the database from scratch) and makes the suite re-runnable.
    await admin.from('api_request_counts').delete().in('user_id', [agent.userId, agent2.userId]);
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
    fail('template', (await admin.from('workout_templates').insert({
      id: TEMPLATE_ID, user_id: agent.userId, title: TEMPLATE_TITLE, type: 'weights', scoring_type: 'strength',
      estimated_duration: 45, difficulty: 3, description: 'W7 fixture', tags: ['fixture'],
      exercises: [{ id: 'fx-press', name: 'fx press', definitionId: DEF_ID, category: 'strength', sets: 3, reps: '8', weight: '100 lb' }],
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
      // The fat split rides along since W10: the phone's composer reopens a
      // meal with it. Calories stay derived (594) — the split is not summed.
      { id: MEAL_IDS[1], user_id: agent.userId, title: 'Fixture Chicken Bowl', date: FIXTURE_DAY, time: '12:45', meal_type: 'lunch',
        protein_g: 48, carbs_g: 60, fat_total_g: 18, fat_saturated_g: 4, fat_trans_g: 0 },
    ])).error);
    fail('favorite', (await admin.from('meal_favorites').insert({
      id: FAVORITE_ID, user_id: agent.userId, title: 'Fixture Overnight Oats', meal_type: 'breakfast',
      calories: 420, protein_g: 18, carbs_g: 60, fat_total_g: 12, fat_saturated_g: 2, notes: 'Prep the night before.',
    })).error);

    // ---- W10: an objective and two blocks on agent. The base block covers
    // FIXTURE_DAY (its second week) and the tracked 09-22 finish (a PR inside
    // the block); the spring block is in the past with no targets, the case
    // `block_id` exists for. Ids are server uuids: see STABLE_IDS.
    const objective = await admin.from('objectives').insert({
      user_id: agent.userId, name: OBJECTIVE_NAME, target_date: '2027-05-01', discipline: 'alpine',
      notes: '', required_capabilities: [], status: 'active',
    }).select('id').single();
    fail('objective', objective.error);
    seededIds.set(objective.data!.id, STABLE_IDS.objective);
    const blocks = await admin.from('training_blocks').insert([
      { user_id: agent.userId, name: BASE_BLOCK_NAME, intent: 'Aerobic base before the spring push.', phase: 'base',
        objective_id: objective.data!.id, start_date: '2026-08-31', end_date_exclusive: '2026-09-28',
        weekly_targets: { cardioMinutes: 60, strengthSessions: 1 } },
      { user_id: agent.userId, name: SPRING_BLOCK_NAME, intent: '', phase: 'build', objective_id: null,
        start_date: '2026-03-02', end_date_exclusive: '2026-03-30', weekly_targets: {} },
    ]).select('id, name');
    fail('blocks', blocks.error);
    for (const row of blocks.data!) {
      seededIds.set(row.id, row.name === BASE_BLOCK_NAME ? STABLE_IDS.base : STABLE_IDS.spring);
    }
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

    // ---- W9: what the dashboard tiles compute over. A climbing definition
    // makes the crag's set-log rows pitches (grade text in actual_weight); a
    // cardio row with an unreadable distance is what the excluded-entries
    // footnote counts. Named without "Fixture" so search_exercises('fixture')
    // keeps its fixture.
    fail('climb definition', (await admin.from('exercise_definitions').insert({
      id: CLIMB_DEF_ID, user_id: agent.userId, canonical_name: 'Ragged Arete', category: 'climbing',
      aliases: [], muscle_groups: [], equipment: [], is_unilateral: false,
    })).error);
    fail('pitch logs', (await admin.from('workout_set_logs').insert([
      { user_id: agent.userId, event_id: CRAG_ID, event_date: FIXTURE_DAY, section: 'exercise', exercise_id: 'fx-p1',
        exercise_name: 'Ragged Arete', definition_id: CLIMB_DEF_ID, set_number: 1, actual_weight: '5.10c', actual_reps: null, is_autofilled: false },
      { user_id: agent.userId, event_id: CRAG_ID, event_date: FIXTURE_DAY, section: 'exercise', exercise_id: 'fx-p2',
        exercise_name: 'Ragged Arete', definition_id: CLIMB_DEF_ID, set_number: 2, actual_weight: '5.9', actual_reps: null, is_autofilled: false },
    ])).error);
    fail('cardio logs', (await admin.from('workout_cardio_logs').insert([
      { user_id: agent.userId, event_id: RUN_ID, event_date: FIXTURE_DAY, section: 'exercise', exercise_id: 'fx-run',
        exercise_name: 'Fixture Easy Run', duration_minutes: 40, distance: '5 mi', elevation_gain: '800 ft', avg_heart_rate: 150, is_autofilled: false },
      { user_id: agent.userId, event_id: RUN_ID, event_date: FIXTURE_DAY, section: 'cooldown', exercise_id: 'fx-jog',
        exercise_name: 'Fixture Cooldown Jog', duration_minutes: 10, distance: 'far', elevation_gain: null, avg_heart_rate: null, is_autofilled: false },
    ])).error);
    fail('tiles', (await admin.from('analytics_tiles').insert(TILE_SPECS.map((t, i) => ({
      id: t.id, user_id: agent.userId, spec: t.spec, x: 0, y: i * 4, w: 6, h: 4,
    })))).error);

    // ---- W11: the You tab's own surfaces, all on agent2 (see SYNC_TZ above).

    // isCorosConfigured() gates the section's visibility, and a fixture that
    // said `configured: false` would describe a deployment nobody ships.
    process.env.COROS_CLIENT_ID = 'fixture-client';
    process.env.COROS_REDIRECT_URI = 'https://apextrainingcalendar.vercel.app/api/provider-callback';

    // A connected row. No API_KEY_ENCRYPTION_SECRET in the test env, so the
    // plaintext token round-trips through unsealed() (provider-sync's note).
    fail('connection', (await admin.from('provider_connections').upsert({
      user_id: agent2.userId, provider: 'coros',
      access_token: 'stub-token', refresh_token: 'stub-refresh',
      token_expires_at: '2099-01-01T00:00:00Z',
      status: 'connected', connected_at: '2026-09-01T12:00:00Z',
      last_synced_at: '2026-09-09T02:00:00Z', auto_sync: true,
    }, { onConflict: 'user_id,provider' })).error);

    // The planned run the stubbed trail run matches, on that activity's LOCAL
    // date — which is what makes preview propose a fill rather than a create.
    fail('planned run', (await admin.from('workout_events').insert({
      id: PLANNED_RUN_ID, user_id: agent2.userId, type: 'cardio',
      title: 'Planned Morning Run',
      date: new Intl.DateTimeFormat('en-CA', { timeZone: SYNC_TZ }).format(new Date(SYNC.runUtc)),
      start_time: '7:00 AM', estimated_duration: 45, description: '', difficulty: 3,
      tags: [], equipment: [], warmup: [], cooldown: [], is_recurring: false,
      exercises: [{ id: 'fx-run', name: 'Trail Run', category: 'cardio', duration: '45 min' }],
    })).error);

    // One live connector grant, so the "connected apps" list has a row. Only
    // `kind: 'refresh'` grants are projected as connections.
    fail('grant', (await admin.from('mcp_tokens').insert({
      user_id: agent2.userId, kind: 'refresh', name: CONNECTED_APP_NAME,
      client_id: CONNECTED_APP_CLIENT, token_hash: 'fixture-grant-hash', token_last4: 'aaaa',
    })).error);

    // Activity-log rows covering all four sources and both badges. logged_at
    // is explicit so the merge order is the fixture's, not the clock's.
    fail('event log', (await admin.from('event_mutations_log').insert([
      { user_id: agent2.userId, operation: 'create', event_id: PLANNED_RUN_ID, event_title: LOG_EVENT_TITLE,
        event_date: '2026-09-08', triggered_by: 'user', logged_at: '2026-09-08T10:00:00Z' },
      { user_id: agent2.userId, operation: 'update_instance', event_id: PLANNED_RUN_ID, event_title: LOG_EVENT_TITLE,
        event_date: '2026-09-09', triggered_by: 'ai', logged_at: '2026-09-09T11:00:00Z' },
    ])).error);
    fail('definition log', (await admin.from('definition_mutations_log').insert({
      user_id: agent2.userId, operation: 'archive', definition_id: `${FX}-log-def`, definition_name: LOG_DEF_NAME,
      triggered_by: 'user', logged_at: '2026-09-07T09:00:00Z',
    })).error);
    fail('block log', (await admin.from('block_mutations_log').insert([
      { user_id: agent2.userId, operation: 'create', resource: 'block', resource_id: '00000000-0000-4000-8000-00000000b10c',
        resource_name: LOG_BLOCK_NAME, triggered_by: 'ai', logged_at: '2026-09-06T08:00:00Z' },
      { user_id: agent2.userId, operation: 'update', resource: 'objective', resource_id: '00000000-0000-4000-8000-0000000000b1',
        resource_name: LOG_OBJECTIVE_NAME, triggered_by: 'user', logged_at: '2026-09-05T07:00:00Z' },
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

  it('workout-draft: Apply on the server — create with a template match, edit, detach — and the draft reduce', async () => {
    // The reduce the builder coach drives: the alias 'fx press' resolves to the fixture definition.
    const reduce = makeRes();
    await coachToolHandler(makeReq({
      method: 'POST', token: agent.token,
      body: {
        name: 'update_workout_draft', today: FIXTURE_DAY, draft: emptyDraft('2026-09-15'),
        input: { title: 'Fixture Coach Draft', exercises: [{ name: 'fx press', sets: 3, reps: '8' }], repeat: { days: ['TU'] } },
      },
    }), reduce.res);
    expect(reduce.statusCode).toBe(200);
    const reduced = reduce.body as { ok: boolean; draft: { title: string; lists: { exercises: Array<{ definitionId?: string }> }; repeat: { days: string[] } } };
    expect(reduced.ok).toBe(true);
    expect(reduced.draft.title).toBe('Fixture Coach Draft');
    expect(reduced.draft.lists.exercises[0].definitionId).toBe(DEF_ID);
    expect(reduced.draft.repeat.days).toEqual(['TU']);
    fixture('coach-tool-draft.json', reduce.body);

    const createdIds: string[] = [];
    try {
      // Create: the seeded template's title (no templateId in the draft)
      // resolves to its id; a one-off dated yesterday is a retro-log.
      const create = makeRes();
      await workoutDraftHandler(makeReq({
        method: 'POST', token: agent.token,
        body: {
          today: FIXTURE_DAY, action: { kind: 'create' },
          draft: {
            ...emptyDraft('2026-09-07', TEMPLATE_TITLE), startTime: '06:30', endTime: '07:15', duration: '45',
            lists: { warmup: [], cooldown: [], exercises: reduced.draft.lists.exercises },
          },
        },
      }), create.res);
      expect(create.statusCode).toBe(200);
      const created = create.body as { ok: boolean; id: string; templateId: string; completedOnCreate: boolean; event: { title: string } };
      expect(created).toMatchObject({ ok: true, action: 'create', templateId: TEMPLATE_ID, completedOnCreate: true, isRecurring: false });
      createdIds.push(created.id);
      const { data: row } = await admin.from('workout_events').select('template_id, start_time, user_id').eq('id', created.id).single();
      expect(row).toEqual({ template_id: TEMPLATE_ID, start_time: '6:30 AM', user_id: agent.userId });
      expect((await admin.from('workout_completions').select('is_completed').eq('event_id', created.id).single()).data).toEqual({ is_completed: true });
      const { data: log } = await admin.from('event_mutations_log').select('triggered_by').eq('event_id', created.id).single();
      expect(log).toEqual({ triggered_by: 'user' });
      fixture('workout-draft-create.json', create.body);

      // Edit the one-off: schedule fields included, the title changes.
      const edit = makeRes();
      await workoutDraftHandler(makeReq({
        method: 'POST', token: agent.token,
        body: {
          today: FIXTURE_DAY, action: { kind: 'update', eventId: created.id },
          draft: { ...emptyDraft('2026-09-07', `${TEMPLATE_TITLE} (edited)`), startTime: '07:00', duration: '50' },
        },
      }), edit.res);
      expect(edit.statusCode).toBe(200);
      expect(edit.body).toMatchObject({ ok: true, action: 'update', id: created.id, event: { title: `${TEMPLATE_TITLE} (edited)`, startTime: '7:00 AM' } });
      expect((await admin.from('workout_events').select('title').eq('id', created.id).single()).data).toEqual({ title: `${TEMPLATE_TITLE} (edited)` });
      fixture('workout-draft-edit.json', edit.body);

      // Detach one occurrence of the weekly series: a standalone row plus a skip.
      const detach = makeRes();
      await workoutDraftHandler(makeReq({
        method: 'POST', token: agent.token,
        body: {
          today: FIXTURE_DAY, action: { kind: 'detach', eventId: `${EVENT_ID}__2026-09-29`, occurrenceDate: '2026-09-29' },
          draft: { ...emptyDraft('2026-09-30', 'Fixture Push Day (solo)'), duration: '60' },
        },
      }), detach.res);
      expect(detach.statusCode).toBe(200);
      const detached = detach.body as { id: string };
      createdIds.push(detached.id);
      expect(detach.body).toMatchObject({ ok: true, action: 'detach', detachedFrom: EVENT_ID, occurrenceDate: '2026-09-29', date: '2026-09-30', isRecurring: false });
      const { data: skip } = await admin.from('recurring_exceptions').select('override_date').eq('event_id', EVENT_ID).eq('skipped_date', '2026-09-29').single();
      expect(skip).toEqual({ override_date: null });
      fixture('workout-draft-detach.json', detach.body);

      // Another user's draft cannot edit it.
      const other = makeRes();
      await workoutDraftHandler(makeReq({
        method: 'POST', token: agent2.token,
        body: { today: FIXTURE_DAY, action: { kind: 'update', eventId: created.id }, draft: emptyDraft('2026-09-07', 'x') },
      }), other.res);
      expect(other.statusCode).toBe(404);

      // A validation problem answers 200 ok:false with the web's text and writes nothing.
      const bad = makeRes();
      await workoutDraftHandler(makeReq({
        method: 'POST', token: agent.token,
        body: { today: FIXTURE_DAY, action: { kind: 'create' }, draft: emptyDraft('2026-09-07', '') },
      }), bad.res);
      expect(bad.statusCode).toBe(200);
      expect(bad.body).toEqual({ ok: false, problem: 'Give the workout a title' });
    } finally {
      // The chat fixture's label names the 09-29 occurrence — put it back.
      await admin.from('recurring_exceptions').delete().eq('event_id', EVENT_ID).eq('skipped_date', '2026-09-29');
      if (createdIds.length) {
        for (const table of ['workout_set_logs', 'workout_cardio_logs', 'workout_sessions', 'workout_completion_log', 'workout_completions', 'event_mutations_log']) {
          await admin.from(table).delete().in('event_id', createdIds);
        }
        await admin.from('workout_events').delete().in('id', createdIds);
      }
    }
  });

  it('chat v2 (builder): one tool, the draft in context, no label on the tool_use', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-ant-integration');
    const c = makeRes();
    const chunks: string[] = [];
    (c.res as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    (c.res as unknown as { on: () => unknown }).on = () => c.res;
    await chatHandler(makeReq({
      method: 'POST', token: agent.token,
      body: {
        mode: 'builder', today: FIXTURE_DAY, withTools: true, context: { draft: emptyDraft('2026-09-15', 'Fixture Coach Draft') },
        messages: [{ role: 'user', content: 'add fixture press, 3 sets of 8' }],
      },
    }), c.res);
    expect(c.statusCode).toBe(200);
    const events = chunks.join('').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(events.map(e => e.type)).toEqual(['text', 'tool_use', 'done']);
    expect(events[1]).toMatchObject({ name: 'update_workout_draft', input: { exercises: [{ name: 'fx press', sets: 3, reps: '8' }] } });
    expect(events[1].label).toBeUndefined();
    fixture('chat-stream-builder.ndjson', chunks.join(''));
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

  it('analytics tiles + compute: the dashboard read, the engine over the caller\'s rows, the draft bodies, and the chart-draft reduce (W8, W9)', async () => {
    type TileView = { id: string; title: string; spec: Record<string, unknown> | null; draft: Record<string, unknown> | null; layout: { x: number; y: number; w: number; h: number }; updatedAt: string | null };
    type Tiles = { tiles: TileView[]; options: { categories: string[]; otherWorkoutTitles: string[] } };
    type Tile = { ok: boolean; data?: { series: Array<{ key: string; points: Array<number | null>; gradeLabels?: Array<string | null> }>; excluded: { otherUnit: number; unparseable: number } }; problem?: string };

    // GET: every seeded tile in y order, each with the draft its spec unfolds to.
    const list = makeRes();
    await analyticsTilesHandler(makeReq({ method: 'GET', token: agent.token }), list.res);
    expect(list.statusCode).toBe(200);
    const body = list.body as Tiles;
    const carved: Tiles = { tiles: body.tiles.filter(t => t.id.startsWith(TILE_PREFIX)), options: body.options };
    expect(carved.tiles.map(t => t.id)).toEqual(TILE_SPECS.map(t => t.id));
    expect(carved.tiles[0]).toMatchObject({ title: 'Sessions', draft: { chartType: 'kpi', rangeKind: 'fixed', startDate: '2026-09-01', endDate: '2026-09-30' }, layout: { x: 0, y: 0, w: 6, h: 4 } });
    expect(carved.tiles[3].draft).toMatchObject({ chartType: 'table', series: [{ measure: 'max-grade', gradeScale: 'yds' }] });
    expect(carved.options.categories).toEqual(expect.arrayContaining(['climbing', 'strength']));
    expect(JSON.stringify(carved)).not.toContain('user_id');
    fixture('analytics-tiles.json', carved);

    // Compute the served specs in tiles order, plus a spec the engine refuses.
    const specs = [
      ...carved.tiles.map(t => t.spec),
      { version: 1, title: 'broken', chartType: 'line', range: TILE_WINDOW, bucket: 'week', series: [{ id: 's1', measure: 'no-such-measure' }] },
    ];
    const c = makeRes();
    await analyticsComputeHandler(makeReq({ method: 'POST', token: agent.token, body: { specs, today: '2026-09-22' } }), c.res);
    expect(c.statusCode).toBe(200);
    const { tiles } = c.body as { tiles: Tile[] };
    expect(tiles).toHaveLength(7);
    // One completed fixture occurrence in September (09-08); the quick-complete and
    // the tracked finish do not write completions.
    expect(tiles[0].ok).toBe(true);
    expect(tiles[0].data!.series[0].points).toEqual([1]);
    // Tonnage from the real logs, filtered on the canonical 'Fixture Press':
    // 100×5 + 110×3 logged 09-08 under the alias 'fx press', 120×3 logged
    // 09-22 under the canonical name; autofilled rows excluded.
    expect(tiles[1].ok).toBe(true);
    const weekly = tiles[1].data!.series[0].points.map(p => p ?? 0);
    expect(weekly).toEqual([0, 830, 0, 360, 0]);
    expect(weekly.reduce((a, b) => a + b, 0)).toBe(1190);
    // The split fans out per workout type — the key the phone colours by.
    expect(tiles[2].data!.series.map(s => s.key)).toContain('s1:weights');
    // The crag's pitches carry their grade text; a rank is never shown.
    expect(tiles[3].ok).toBe(true);
    expect(tiles[3].data!.series[0].gradeLabels).toContain('5.10c');
    // Avg HR is null in a week with no cardio — a gap, not a zero.
    expect(tiles[4].data!.series[0].points).toContain(null);
    expect(tiles[4].data!.series[0].points).toContain(150);
    // 'far' is not a distance: excluded, counted, footnoted.
    expect(tiles[5].data!.excluded.unparseable).toBeGreaterThanOrEqual(1);
    expect(tiles[6].ok).toBe(false);
    expect(tiles[6].problem).toBeTruthy();
    fixture('analytics-compute.json', c.body);

    // Another user's tiles never see these rows.
    const other = makeRes();
    await analyticsComputeHandler(makeReq({ method: 'POST', token: agent2.token, body: { specs: [specs[1]], today: '2026-09-22' } }), other.res);
    expect(other.statusCode).toBe(200);
    const otherWeekly = (other.body as { tiles: Tile[] }).tiles[0].data?.series[0]?.points.map(p => p ?? 0) ?? [];
    expect(otherWeekly.reduce((a, b) => a + b, 0)).toBe(0);
    const otherList = makeRes();
    await analyticsTilesHandler(makeReq({ method: 'GET', token: agent2.token }), otherList.res);
    expect((otherList.body as Tiles).tiles.filter(t => t.id.startsWith(TILE_PREFIX))).toEqual([]);

    // The builder's live preview: a draft the web would refuse answers its text in the slot.
    const empty = emptyChartDraft();
    fixture('chart-draft-empty.json', empty);
    const preview = makeRes();
    await analyticsComputeHandler(makeReq({ method: 'POST', token: agent.token, body: { drafts: [empty], today: '2026-09-22' } }), preview.res);
    expect(preview.statusCode).toBe(200);
    expect((preview.body as { tiles: Tile[] }).tiles).toEqual([{ ok: false, problem: 'Every series needs a measure.' }]);
    fixture('analytics-compute-preview.json', preview.body);

    // The analytics coach's reduce: the same stateless path as the workout draft.
    const reduce = makeRes();
    await coachToolHandler(makeReq({
      method: 'POST', token: agent.token,
      body: {
        name: 'update_chart_draft', today: FIXTURE_DAY, draft: empty,
        input: { title: 'Fixture weekly tonnage', chart_type: 'bar', bucket: 'week', series: [{ id: 's1', measure: 'tonnage' }] },
      },
    }), reduce.res);
    expect(reduce.statusCode).toBe(200);
    const reduced = reduce.body as { ok: boolean; resultText: string; draft: { title: string; chartType: string; series: Array<{ measure: string }> } };
    expect(reduced.ok).toBe(true);
    expect(reduced.resultText).toContain('Chart draft updated');
    expect(reduced.draft).toMatchObject({ title: 'Fixture weekly tonnage', chartType: 'bar', bucket: 'week', series: [{ id: 's1', measure: 'tonnage' }] });
    fixture('coach-tool-chart-draft.json', reduce.body);

    // Save the reduced draft through the draft body; the server converts and answers the tile.
    const saveId = `${TILE_PREFIX}save`;
    try {
      const save = makeRes();
      await analyticsTilesHandler(makeReq({
        method: 'POST', token: agent.token,
        body: { id: saveId, draft: reduced.draft, layout: { x: 0, y: 24, w: 12, h: 4 } },
      }), save.res);
      expect(save.statusCode).toBe(200);
      expect(save.body).toMatchObject({ ok: true, id: saveId, tile: { id: saveId, title: 'Fixture weekly tonnage', layout: { x: 0, y: 24, w: 12, h: 4 } } });
      const { data: row } = await admin.from('analytics_tiles').select('spec, user_id').eq('id', saveId).single();
      expect(row).toMatchObject({ user_id: agent.userId, spec: { title: 'Fixture weekly tonnage', chartType: 'bar', bucket: 'week' } });
      fixture('analytics-tiles-save.json', save.body);

      // A blank title is refused with the web's own text, on a 200, writing nothing.
      const blank = makeRes();
      await analyticsTilesHandler(makeReq({ method: 'POST', token: agent.token, body: { id: `${saveId}-blank`, draft: { ...reduced.draft, title: '' } } }), blank.res);
      expect(blank.statusCode).toBe(200);
      expect(blank.body).toEqual({ ok: false, problem: 'Give the tile a title' });
    } finally {
      await admin.from('analytics_tiles').delete().like('id', `${saveId}%`);
    }
  });

  it('chat v2 (analytics): one tool, the chart draft in context, no label on the tool_use', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-ant-integration');
    const c = makeRes();
    const chunks: string[] = [];
    (c.res as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    (c.res as unknown as { on: () => unknown }).on = () => c.res;
    await chatHandler(makeReq({
      method: 'POST', token: agent.token,
      body: {
        mode: 'analytics', today: FIXTURE_DAY, withTools: true, context: { draft: emptyChartDraft() },
        messages: [{ role: 'user', content: 'weekly tonnage as bars' }],
      },
    }), c.res);
    expect(c.statusCode).toBe(200);
    const events = chunks.join('').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(events.map(e => e.type)).toEqual(['text', 'tool_use', 'done']);
    expect(events[1]).toMatchObject({ name: 'update_chart_draft', input: { title: 'Fixture weekly tonnage', chart_type: 'bar' } });
    expect(events[1].label).toBeUndefined();
    fixture('chat-stream-analytics.ndjson', chunks.join(''));
  });

  it('emits (or checks) the iOS fixture contract from real responses', async () => {
    type ScheduleBody = { window: unknown; bases: Array<{ id: string }>; occurrences: Array<{ id: string; baseId: string; date: string; originalDate: string }>; definitions: Array<{ id: string }>; templates: Array<{ id: string }> };
    // Sorted: Postgres returns same-day rows in whatever order it likes, and a
    // fixture that reshuffles between runs is a fixture that always "drifts".
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const carve = (body: ScheduleBody) => ({
      window: body.window,
      bases: body.bases.filter(b => b.id.startsWith(FX)).sort(byId),
      occurrences: body.occurrences.filter(o => o.baseId.startsWith(FX))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
      definitions: body.definitions.filter(d => d.id === DEF_ID),
      templates: body.templates.filter(t => t.id.startsWith(FX)).sort(byId),
    });
    const sched = await schedule(agent.token, { start: '2026-09-01', end: '2026-09-30', include: 'definitions,templates' });
    const carved = carve(sched.body as ScheduleBody);
    // Four bases: the weekly series plus the three one-offs on FIXTURE_DAY.
    expect(carved.bases.map(b => b.id).sort()).toEqual([CIRCUIT_ID, CRAG_ID, RUN_ID, EVENT_ID].sort());
    expect(carved.templates.map(t => t.id)).toEqual([TEMPLATE_ID]);
    // W7: every stub says which date its exception row keys on — the anchor's
    // is its own row date, a generated occurrence's is the date in its id.
    expect(carved.occurrences.find(o => o.id === EVENT_ID)).toMatchObject({ date: '2026-09-01', originalDate: '2026-09-01' });
    expect(carved.occurrences.find(o => o.id === DONE_OCCURRENCE)).toMatchObject({ originalDate: '2026-09-08' });
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

    // W10: entries carry their id and, on request, how many planned workouts
    // use them — the weekly base is the one event with fx press.
    const search = await query(agent.token, { tool: 'search_exercises', args: { query: 'fixture', include_references: true } });
    expect((search.body as { result: { exercises: Array<{ id: string; references: number }> } }).result.exercises)
      .toEqual([expect.objectContaining({ id: DEF_ID, references: 1 })]);
    fixture('query-search_exercises.json', search.body);
    fixture('query-get_prs.json', (await query(agent.token, { tool: 'get_prs', args: { exercise_name: 'Fixture Press' } })).body);

    // The fixture pins the NO-KEY state. getAnthropicKey is mocked for the
    // chat tests above, and a `mockResolvedValueOnce` any of them primed but
    // did not consume would otherwise be spent here — reporting a key the
    // seeded user does not have, and failing the drift check as if the shape
    // had changed. Seen once; this is the guard.
    vi.mocked(getAnthropicKey).mockResolvedValueOnce(null);
    const prof = makeRes();
    await profileHandler(makeReq({ method: 'GET', token: agent.token }), prof.res);
    expect(prof.statusCode).toBe(200);
    // W6: the coach model rides on the profile response so the native app's
    // badge never reads the profiles row directly. The seeded user has no
    // pick, so the label is the default's.
    expect(prof.body).toMatchObject({ coachModel: null, coachModelLabel: 'Opus 5' });
    // W11 widened the same response to the rest of the profiles row, so the
    // You tab reads one endpoint instead of the table.
    expect(prof.body).toMatchObject({ displayName: 'agent', avatarKey: 'goat' });
    // The feed URL is composed server-side; the ics_token is scrubbed by
    // normalize() on its way into the file, never committed.
    expect(String((prof.body as { calendarFeedUrl: string }).calendarFeedUrl))
      .toMatch(/\/api\/calendar-feed\?token=[0-9a-f-]{36}$/);
    fixture('profile.json', prof.body);
  });

  // W11 — the You tab's own surfaces. All on agent2: see the note by SYNC_TZ.
  it('emits the profile, activity-log, connector and COROS fixtures', async () => {
    // ---- Activity log. The feed is not id-prefixed, so the fixture is the
    // fixture-named subset of it — the activity-streams precedent above.
    const log = makeRes();
    await mutationsLogHandler(makeReq({ method: 'GET', token: agent2.token }), log.res);
    expect(log.statusCode).toBe(200);
    const names = new Set([LOG_EVENT_TITLE, LOG_DEF_NAME, LOG_BLOCK_NAME, LOG_OBJECTIVE_NAME]);
    const entries = (log.body as { entries: { source: string; title: string }[] }).entries
      .filter(e => names.has(e.title));
    // All four sources and both badges, newest first.
    expect(entries.map(e => e.source)).toEqual(['event', 'event', 'definition', 'block', 'objective']);
    fixture('mutations-log.json', { entries });

    // ---- Connector tokens. Minting is the only call that ever reveals the
    // plaintext PAT, which normalize() replaces before anything is written.
    const mint = makeRes();
    await mcpTokensHandler(makeReq({ method: 'POST', token: agent2.token, body: { name: TOKEN_NAME } }), mint.res);
    expect(mint.statusCode).toBe(200);
    const minted = mint.body as { id: string; token: string };
    expect(minted.token).toMatch(/^apx_/);
    fixture('mcp-token-mint.json', mint.body);

    const tokens = makeRes();
    await mcpTokensHandler(makeReq({ method: 'GET', token: agent2.token }), tokens.res);
    expect(tokens.statusCode).toBe(200);
    const listed = tokens.body as {
      tokens: { name: string; token_last4: string }[];
      connections: { client_id: string; name: string }[];
    };
    expect(listed.tokens.map(t => t.name)).toEqual([TOKEN_NAME]);
    expect(listed.tokens[0].token_last4).toBe(minted.token.slice(-4));
    expect(listed.connections.map(c => c.client_id)).toEqual([CONNECTED_APP_CLIENT]);
    fixture('mcp-tokens.json', tokens.body);

    // ---- COROS. status first: `configured` is what decides whether the
    // section renders at all.
    const providerSync = async (body: unknown) => {
      const c = makeRes();
      await providerSyncHandler(makeReq({ method: 'POST', token: agent2.token, body }), c.res);
      return c;
    };

    const status = await providerSync({ action: 'status' });
    expect(status.statusCode).toBe(200);
    expect(status.body).toMatchObject({ coros: { status: 'connected', configured: true, autoSync: true } });
    fixture('provider-status.json', status.body);

    // preview writes nothing: the trail run matches the planned event (a fill
    // the confirmation sheet has to ask about), the ride matches nothing.
    const preview = await providerSync({ action: 'preview', provider: 'coros', timezone: SYNC_TZ });
    expect(preview.statusCode).toBe(200);
    const proposals = (preview.body as { proposals: { activity: { activityId: string; localDate: string }; match: unknown }[] }).proposals;
    expect(proposals.map(p => p.activity.activityId)).toEqual([SYNC.runId, SYNC.rideId]);
    expect(proposals[0].match).not.toBeNull();
    expect(proposals[1].match).toBeNull();
    fixture('provider-preview.json', preview.body);

    // apply executes the decisions the sheet collected: fill the matched run,
    // create a standalone event for the ride.
    const apply = await providerSync({
      action: 'apply', provider: 'coros', timezone: SYNC_TZ,
      decisions: [
        { activityId: SYNC.runId, action: 'fill', targetEventId: PLANNED_RUN_ID, eventDate: proposals[0].activity.localDate },
        { activityId: SYNC.rideId, action: 'create' },
      ],
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.body).toEqual({ created: 1, filled: 1, errors: [] });
    fixture('provider-apply.json', apply.body);
  });

  // W10 — Library, Blocks, Meals. Blocks and objectives are on agent, whose
  // schedule and logs give the base block something to attain.
  it('emits the blocks, exercise-history, favorites, cycle-preview and nutrition fixtures', async () => {
    type Block = { id: string; name: string; objective_id: string | null; current_week: number | null; progress: unknown };
    type BlocksResult = { today: string; current: Block | null; block?: Block; blocks?: Block[]; objectives?: Array<{ id: string; name: string }> };
    const isFixture = (b: { name: string } | null | undefined) => !!b && b.name.startsWith('Fixture');
    const carve = (r: BlocksResult): BlocksResult => ({
      ...r,
      current: isFixture(r.current) ? r.current : null,
      blocks: r.blocks?.filter(isFixture),
      objectives: r.objectives?.filter(isFixture),
    });

    // ---- The list read: every block and objective, no progress, today pinned.
    const list = await query(agent.token, {
      tool: 'get_training_blocks',
      args: { scope: 'all', include_progress: false, include_objectives: true, today: FIXTURE_DAY },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.body as { tool: string; result: BlocksResult };
    const carvedList = { tool: listBody.tool, result: carve(listBody.result) };
    expect(carvedList.result.current).toMatchObject({ name: BASE_BLOCK_NAME, current_week: 2, progress: null });
    expect(carvedList.result.blocks!.map(b => b.name)).toEqual([SPRING_BLOCK_NAME, BASE_BLOCK_NAME]);
    expect(carvedList.result.blocks![0].current_week).toBeNull();
    expect(carvedList.result.blocks![1].objective_id).toBe(realId(STABLE_IDS.objective));
    expect(carvedList.result.objectives!.map(o => o.name)).toEqual([OBJECTIVE_NAME]);
    fixture('query-get_training_blocks.json', stabilize(carvedList));

    // ---- The detail read: one block's progress, by id. Week 1 is complete
    // on FIXTURE_DAY; the tracked 09-22 finish is a PR inside the block.
    const detail = await query(agent.token, {
      tool: 'get_training_blocks', args: { block_id: realId(STABLE_IDS.base), today: FIXTURE_DAY },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.body as { tool: string; result: BlocksResult };
    const progress = detailBody.result.block!.progress as {
      weeks_total: number; weeks_elapsed: number; current_week: number | null;
      to_date: { attainment: Array<{ key: string; source: string }> };
      weeks: Array<{ index: number; is_complete: boolean }>;
      prs: Array<{ kind: string; exerciseName: string; description: string }>;
    };
    expect(detailBody.result.block).toMatchObject({ name: BASE_BLOCK_NAME, current_week: 2 });
    expect(progress).toMatchObject({ weeks_total: 4, weeks_elapsed: 1, current_week: 2 });
    expect(progress.weeks.map(w => w.is_complete)).toEqual([true, false, false, false]);
    // The two authored targets, plus whatever the planned calendar derives
    // (the crag day and its long approach add climbing and long-session rows).
    expect(progress.to_date.attainment.filter(a => a.source === 'authored').map(a => a.key))
      .toEqual(['cardioMinutes', 'strengthSessions']);
    expect(progress.to_date.attainment.some(a => a.source === 'derived')).toBe(true);
    expect(progress.prs).toEqual([expect.objectContaining({ kind: 'oneRM', exerciseName: 'Fixture Press' })]);
    // The current block's progress is not computed twice.
    expect(detailBody.result.current?.progress).toBeNull();
    fixture('query-get_training_blocks-detail.json', stabilize({ tool: detailBody.tool, result: carve(detailBody.result) }));

    // ---- Exercise history by a former spelling: alias-aware, oneRM stats.
    const history = await query(agent.token, { tool: 'get_exercise_history', args: { exercise_name: 'fx press' } });
    expect(history.statusCode).toBe(200);
    expect((history.body as { result: unknown }).result).toMatchObject({
      canonical_name: 'Fixture Press', resolved_from: 'fx press', stat_kind: 'oneRM', total_sessions: 2,
    });
    fixture('query-get_exercise_history.json', history.body);

    // ---- Favorites: the phone's composer reads them through the API.
    const favorites = makeRes();
    await handleMealFavorites(makeReq({ method: 'GET', token: agent.token }), favorites.res);
    expect(favorites.statusCode).toBe(200);
    const favs = (favorites.body as { favorites: Array<{ id: string; title: string }> }).favorites.filter(f => f.id.startsWith(FX));
    expect(favs.map(f => f.title)).toEqual(['Fixture Overnight Oats']);
    fixture('meal-favorites.json', { favorites: favs });

    // ---- The cycle preview: the brief's acceptance is that the endpoint
    // equals cadence.ts's own preview. A Wednesday start snaps to its Monday.
    const cycle = async (spec: unknown) => {
      const c = makeRes();
      await blockCycleHandler(makeReq({ method: 'POST', token: agent.token, query: { resource: 'cycle' }, body: { spec } }), c.res);
      return c;
    };
    const spec: CycleSpec = {
      startDate: '2027-01-06', weeksOn: 3, weeksOff: 1, cycles: 2, namePrefix: 'Fixture Cycle',
      intent: 'Winter build', objectiveId: realId(STABLE_IDS.objective),
      weeklyTargets: { cardioMinutes: 300, strengthSessions: 2, vert: { value: 3000, unit: 'ft' } },
      recoveryScale: 0.5,
    };
    const ok = await cycle(spec);
    expect(ok.statusCode).toBe(200);
    const okBody = ok.body as { ok: boolean; blocks: ReturnType<typeof generateCycle>; rows: unknown[]; totalWeeks: number; conflict: unknown };
    expect(okBody).toMatchObject({ ok: true, totalWeeks: 8, conflict: null });
    expect(okBody.blocks).toEqual(generateCycle(spec));
    expect(okBody.blocks.map(b => b.name)).toEqual(['Fixture Cycle · Build 1', 'Fixture Cycle · Recovery 1', 'Fixture Cycle · Build 2', 'Fixture Cycle · Recovery 2']);
    expect(okBody.blocks[0].startDate).toBe('2027-01-04');
    expect(okBody.blocks[1].weeklyTargets).toEqual({ cardioMinutes: 150, strengthSessions: 1, vert: { value: 1500, unit: 'ft' } });
    fixture('blocks-cycle.json', stabilize(ok.body));

    // Overlapping the seeded base block names it; the preview still renders.
    const conflict = await cycle({ ...spec, startDate: '2026-08-31' });
    expect(conflict.statusCode).toBe(200);
    expect(conflict.body).toMatchObject({ ok: true, conflict: { name: BASE_BLOCK_NAME, startDate: '2026-08-31' } });
    fixture('blocks-cycle-conflict.json', stabilize(conflict.body));

    const problem = await cycle({ ...spec, namePrefix: '' });
    expect(problem.statusCode).toBe(200);
    expect(problem.body).toEqual({ ok: false, problem: 'A cycle needs a name' });
    fixture('blocks-cycle-problem.json', problem.body);

    // The rows commit through the batch insert untouched — what the phone
    // does after a preview. cleanup() takes them by name.
    const commit = makeRes();
    await handleTrainingBlocks(makeReq({
      method: 'POST', token: agent.token, query: { resource: 'block', batch: '1' },
      body: { rows: okBody.rows, log: { resource_name: okBody.blocks[0].name, triggered_by: 'user' } },
    }), commit.res);
    expect(commit.statusCode).toBe(200);
    expect((commit.body as { ids: string[] }).ids).toHaveLength(4);

    // ---- D-033: the Atwater vectors the Swift port is pinned against,
    // computed by the web's own derivedCalories. Halves round up; nothing
    // set is null, not zero.
    const inputs = [
      { proteinG: 48, carbsG: 60, fatTotalG: 18 },
      { proteinG: 20, carbsG: 60, fatTotalG: 10, alcoholG: 14 },
      { proteinG: 22, carbsG: 78, fatTotalG: 12 },
      { carbsG: 0.125 },
      { fatTotalG: 0.0555 },
      { proteinG: 12.5 },
      { alcoholG: 7 },
      { proteinG: 0, carbsG: 0, fatTotalG: 0 },
      {},
    ];
    fixture('nutrition-derived.json', { vectors: inputs.map(input => ({ input, output: derivedCalories(input) })) });
  });
});
