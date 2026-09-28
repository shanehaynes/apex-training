import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { optionalEnv } from '../env.js';
import { getAnthropicKey } from '../anthropicKey.js';
import { makeAnthropicClient } from '../anthropicClient.js';
import { fetchReflectionInputs, isReflectionDay, yesterdayUtc } from '../reflection/inputs.js';
import { REFLECTION_SYSTEM_PROMPT, renderReflectionInput } from '../reflection/prompt.js';
import { reflectForUser, type ReflectOutcome } from '../reflection/reflect.js';
import { resolveCoachModel } from '../../../src/lib/coach/models.js';

// The nightly reflection cron (lane D01), the target vercel.json schedules
// at 05:00 UTC — after provider-cron's 03:30 has pulled the day's activities
// in, before review-cron's 14:00. Same auth as the other two: Vercel sends
// Authorization: Bearer $CRON_SECRET on cron invocations.
//
// For every athlete who opted in (profiles.reflection_opt_in) it reflects on
// yesterday (UTC): reads the day's completed sessions, chat, physiology and
// memory, asks the coach model — on the athlete's own key, at the model they
// picked — what is worth remembering and whether the coaching contract
// should change, and writes the answers as UNCONFIRMED rows the notebook
// shows. Nothing applies until the athlete clicks (D-C02).
//
// Idempotent per (user, day) on the coach_reflections row
// (api/_lib/reflection/reflect.ts), so a manual run and the scheduled one
// cannot propose twice. Budgeted like review-cron: at most
// MAX_WORK_ITEMS_PER_RUN model calls per invocation, and no new one starts
// once WORK_BUDGET_MS has elapsed — a night with more work than that
// carries the rest to the next night, whose "already-done" rows skip
// instantly. Two 20 s attempts per call (anthropicClient.ts) inside the
// catch-all function's 60 s maxDuration.
//
// Escape hatches for manual operation: ?userId= limits to one athlete,
// ?day=YYYY-MM-DD picks the day, ?dryRun=1 (with userId) renders the prompt
// that WOULD be sent and touches nothing — no row, no model call.

/** Model calls one invocation may make; the rest resume next night. */
export const MAX_WORK_ITEMS_PER_RUN = 10;

/** Past this many ms since the handler started, no further model call begins. */
export const WORK_BUDGET_MS = 40_000;

interface OptedIn {
  userId: string;
  coachModel: string | null;
}

function queryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** True when the column the opt-in lives in has not reached this database yet. */
function isOptInColumnMissing(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204')
    && /reflection_opt_in/.test(error.message ?? '');
}

/** Everyone who switched the reflection on, or null when the column is not there yet. */
export async function listOptedIn(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>): Promise<OptedIn[] | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, coach_model')
    .eq('reflection_opt_in', true);
  if (error) {
    if (isOptInColumnMissing(error)) return null;
    throw new Error(`profiles fetch failed: ${error.message}`);
  }
  return (data ?? [])
    .map(p => ({ userId: p.id, coachModel: p.coach_model ?? null }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = optionalEnv('CRON_SECRET');
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).send('Unauthorized');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const startedAt = Date.now();
  const now = new Date();
  const dayParam = queryString(req, 'day');
  if (dayParam !== undefined && !isReflectionDay(dayParam)) {
    res.status(400).send('day must be YYYY-MM-DD');
    return;
  }
  const day = dayParam ?? yesterdayUtc(now);
  const onlyUserId = queryString(req, 'userId');
  const dryRun = queryString(req, 'dryRun') === '1';

  let users: OptedIn[] | null;
  try {
    users = await listOptedIn(supabase);
  } catch (err) {
    console.error('[reflection-cron] listing failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to list opted-in users');
    return;
  }
  if (users === null) {
    // The migration has not reached this database: nothing to do, and not
    // an error worth a nightly alert.
    res.status(200).json({ day, processed: [], errors: [], note: 'reflection_opt_in column missing' });
    return;
  }
  if (onlyUserId) users = users.filter(u => u.userId === onlyUserId);

  // Dry run: render the prompt for one athlete and return it, touching nothing.
  if (dryRun) {
    if (!onlyUserId || users.length !== 1) {
      res.status(400).send('dryRun needs userId of an opted-in athlete');
      return;
    }
    try {
      const inputs = await fetchReflectionInputs(supabase, onlyUserId, day);
      const model = resolveCoachModel(users[0].coachModel);
      res.status(200).json({
        dryRun: true, day, model: model.id, inputs, system: REFLECTION_SYSTEM_PROMPT, user: renderReflectionInput(inputs),
      });
    } catch (err) {
      console.error('[reflection-cron] dry run failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Dry run failed');
    }
    return;
  }

  const processed: Array<{ userId: string; action: string; memoriesProposed?: number; contractProposed?: boolean }> = [];
  const errors: Array<{ userId: string; error: string }> = [];
  let workBudget = MAX_WORK_ITEMS_PER_RUN;

  for (const user of users) {
    const label = { userId: user.userId };
    try {
      if (workBudget <= 0 || Date.now() - startedAt > WORK_BUDGET_MS) {
        processed.push({ ...label, action: 'deferred' });
        continue;
      }
      const apiKey = await getAnthropicKey(supabase, user.userId);
      if (!apiKey) {
        // No key, no model call — and no row, so the night is reflected on
        // once a key is saved and the day is still yesterday.
        processed.push({ ...label, action: 'skipped-no-key' });
        continue;
      }
      workBudget -= 1;
      const outcome: ReflectOutcome = await reflectForUser(supabase, {
        userId: user.userId,
        day,
        model: resolveCoachModel(user.coachModel).id,
        client: makeAnthropicClient(apiKey),
      }, now);
      processed.push({
        ...label,
        action: outcome.action,
        memoriesProposed: outcome.memoriesProposed,
        contractProposed: outcome.contractProposed,
      });
      if (outcome.error) errors.push({ ...label, error: outcome.error });
    } catch (err) {
      // Per-user isolation: one athlete's failure must not stop the run.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[reflection-cron] ${user.userId} failed:`, detail);
      errors.push({ ...label, error: detail });
    }
  }

  console.log(`[reflection-cron] ${day}: ${processed.length} athlete(s), ${errors.length} error(s)`);
  res.status(200).json({ day, processed, errors });
}
