// Integration tests for POST /api/workout-sessions `save` against the LOCAL
// Supabase stack: a batch whose rows carry different optional columns.
// supabase-js sends the union of a batch's columns and PostgREST fills the
// gaps with NULL, which the NOT NULL is_warmup column rejects (23502).
//
// Runs as its own throwaway user: ios-read.integration.test.ts snapshots
// agent@apex.local's PRs into a fixture from a parallel worker, so a squat
// written here under that user drifts the fixture whenever the two overlap.
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped entirely when APEX_LOCAL_SUPABASE is unset.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import workoutSessionsHandler from '../../_lib/handlers/workoutSessions';
import acceptanceHandler from '../../_lib/handlers/termsAcceptance';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;

const EVENT_ID = 'itest-save-mixed';
const EVENT_DATE = '2026-06-16';

function call(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<unknown> | unknown,
  token: string,
  body: unknown,
) {
  const captured = { statusCode: 200, body: undefined as unknown };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(b: unknown) { captured.body = b; return res; },
    send(b: unknown) { captured.body = b; return res; },
    write: () => true,
    end: () => res,
  } as unknown as VercelResponse;
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    body,
    cookies: {},
  } as unknown as VercelRequest;
  return Promise.resolve(handler(req, res)).then(() => captured);
}

const post = (token: string, body: unknown) => call(workoutSessionsHandler, token, body);

function setRow(setNumber: number, extra: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID, event_date: EVENT_DATE, section: 'exercise',
    exercise_id: 'squat', exercise_name: 'Back Squat', set_number: setNumber,
    actual_weight: '135', actual_reps: '5', is_autofilled: false,
    ...extra,
  };
}

describe.skipIf(!RUN)('workout-sessions save with mixed row shapes', () => {
  let admin: SupabaseClient;
  let token: string;
  let userId: string;

  async function savedSets() {
    const { data, error } = await admin
      .from('workout_set_logs')
      .select('set_number, is_warmup, actual_weight')
      .eq('user_id', userId).eq('event_id', EVENT_ID).eq('event_date', EVENT_DATE)
      .order('set_number');
    if (error) throw new Error(error.message);
    return data;
  }

  async function clear() {
    await admin.from('workout_set_logs').delete().eq('user_id', userId).eq('event_id', EVENT_ID);
    await admin.from('workout_cardio_logs').delete().eq('user_id', userId).eq('event_id', EVENT_ID);
  }

  beforeAll(async () => {
    const env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

    const email = `save-mixed-${Date.now()}@apex.local`;
    const password = 'apex-save-mixed-password';
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`user create failed: ${createErr?.message}`);
    userId = created.user.id;

    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`sign-in failed: ${await res.text()}`);
    token = (await res.json() as { access_token: string }).access_token;

    const accepted = await call(acceptanceHandler, token, undefined);
    if (accepted.statusCode !== 200) throw new Error(`terms acceptance failed: ${String(accepted.body)}`);
  });

  afterAll(async () => {
    if (!admin || !userId) return;
    await clear();
    await admin.auth.admin.deleteUser(userId);
  });

  it('saves a batch where one row sets is_warmup and one omits it', async () => {
    const captured = await post(token, {
      action: 'save', eventId: EVENT_ID, eventDate: EVENT_DATE,
      setLogs: [setRow(1, { is_warmup: true }), setRow(2)],
    });
    expect(captured.statusCode, String(captured.body)).toBe(200);
    expect(await savedSets()).toEqual([
      { set_number: 1, is_warmup: true, actual_weight: '135' },
      { set_number: 2, is_warmup: false, actual_weight: '135' },
    ]);
  });

  it('leaves is_warmup alone on an existing row that omits it in a mixed batch', async () => {
    // Set 1 is a warm-up; re-saving it without the key (beside a row that
    // has it) must not reset it to the column default.
    await clear();
    const seeded = await post(token, {
      action: 'save', eventId: EVENT_ID, eventDate: EVENT_DATE,
      setLogs: [setRow(1, { is_warmup: true })],
    });
    expect(seeded.statusCode, String(seeded.body)).toBe(200);
    const captured = await post(token, {
      action: 'save', eventId: EVENT_ID, eventDate: EVENT_DATE,
      setLogs: [setRow(1, { actual_weight: '95' }), setRow(2, { is_warmup: false, actual_weight: '185' })],
    });
    expect(captured.statusCode, String(captured.body)).toBe(200);
    expect(await savedSets()).toEqual([
      { set_number: 1, is_warmup: true, actual_weight: '95' },
      { set_number: 2, is_warmup: false, actual_weight: '185' },
    ]);
  });

  it('saves a cardio batch where one row sets is_autofilled and one omits it', async () => {
    const cardio = (exerciseId: string, extra: Record<string, unknown> = {}) => ({
      event_id: EVENT_ID, event_date: EVENT_DATE, section: 'exercise',
      exercise_id: exerciseId, exercise_name: exerciseId, duration_minutes: 20,
      ...extra,
    });
    const captured = await post(token, {
      action: 'save', eventId: EVENT_ID, eventDate: EVENT_DATE,
      cardioLogs: [cardio('row', { is_autofilled: true }), cardio('run')],
    });
    expect(captured.statusCode, String(captured.body)).toBe(200);
    const { data, error } = await admin
      .from('workout_cardio_logs')
      .select('exercise_id, is_autofilled')
      .eq('user_id', userId).eq('event_id', EVENT_ID).eq('event_date', EVENT_DATE)
      .order('exercise_id');
    if (error) throw new Error(error.message);
    expect(data).toEqual([
      { exercise_id: 'row', is_autofilled: true },
      { exercise_id: 'run', is_autofilled: false },
    ]);
  });
});
