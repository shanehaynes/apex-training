import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { optionalEnv } from '../env.js';
import { getAnthropicKey } from '../anthropicKey.js';
import { makeAnthropicClient } from '../anthropicClient.js';
import { fetchReflectionInputs, isReflectionDay, yesterdayIn, yesterdayUtc } from '../reflection/inputs.js';
import { effectiveTimezone, fetchUserTimezones } from '../userTimezone.js';
import { REFLECTION_SYSTEM_PROMPT, renderReflectionInput } from '../reflection/prompt.js';
import { reflectForUser, type ReflectOutcome } from '../reflection/reflect.js';
import { resolveCoachModel } from '../../../src/lib/coach/models.js';
import { instrumentMessages, promptFingerprint } from '../coachRuns.js';

// The nightly reflection cron (lane D01), the target vercel.json schedules
// at 05:00 UTC — after provider-cron's 03:30 has pulled the day's activities
// in, before review-cron's 14:00. Same auth as the other two: Vercel sends
// Authorization: Bearer $CRON_SECRET on cron invocations.
//
// For every athlete who opted in (profiles.reflection_opt_in) it reflects on
// THEIR yesterday — the last calendar day that has ended in their saved time
// zone (profiles.timezone, phase58; UTC when none): reads the day's completed sessions, chat, physiology and
// memory, asks the coach model — on the athlete's own key, at the model they
// picked — what is worth remembering and whether the coaching contract
// should change, and writes the answers as UNCONFIRMED rows the notebook
// shows. Nothing applies until the athlete clicks (D-C02).
//
// Idempotent per (user, day) on the coach_reflections row
// (api/_lib/reflection/reflect.ts), so a manual run and the scheduled one
// cannot propose twice. Budgeted like review-cron: at most
// MAX_WORK_ITEMS_PER_RUN model calls per invocation, and no new one starts
// once WORK_BUDGET_MS has elapsed. Two 20 s attempts per call
// (anthropicClient.ts) inside the catch-all function's 60 s maxDuration.
//
// Two things keep the budget from starving anyone:
//   - The BACKLOG runs first: rows left `pending` or `failed` on earlier
//     nights (a model outage, a run that died, a parse failure twice over)
//     within the last BACKLOG_DAYS are retried before today's pass, through
//     the same resume path, each costing one budget item. Without this a
//     failed night was failed forever, since work was only ever derived
//     from today's day.
//   - Today's pass ROTATES its start by the day, so with more opted-in
//     athletes than the budget the ones deferred tonight are first tomorrow
//     rather than deferred every night by a stable sort.
//
// Escape hatches for manual operation: ?userId= limits to one athlete,
// ?day=YYYY-MM-DD picks the day, ?dryRun=1 (with userId) renders the prompt
// that WOULD be sent and touches nothing — no row, no model call.

// coach_runs.prompt_version for every reflection call (phase57).
const REFLECTION_PROMPT_VERSION = promptFingerprint(REFLECTION_SYSTEM_PROMPT);

/** Model calls one invocation may make; the rest resume next night. */
export const MAX_WORK_ITEMS_PER_RUN = 10;

/** Past this many ms since the handler started, no further model call begins. */
export const WORK_BUDGET_MS = 40_000;

/** How far back unfinished rows are retried; older ones stay as they are. */
export const BACKLOG_DAYS = 7;

interface OptedIn {
  userId: string;
  coachModel: string | null;
  /** The athlete's zone, UTC when none is saved. */
  timeZone: string;
}

/** One (athlete, day) to reflect on. */
interface WorkItem {
  user: OptedIn;
  day: string;
}

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

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
export async function listOptedIn(supabase: Admin): Promise<OptedIn[] | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, coach_model')
    .eq('reflection_opt_in', true);
  if (error) {
    if (isOptInColumnMissing(error)) return null;
    throw new Error(`profiles fetch failed: ${error.message}`);
  }
  const ids = (data ?? []).map(p => p.id);
  // A separate read, so a database without the timezone column still runs
  // every opted-in athlete — on UTC days, as before phase58.
  const zones = await fetchUserTimezones(supabase, ids);
  return (data ?? [])
    .map(p => ({ userId: p.id, coachModel: p.coach_model ?? null, timeZone: effectiveTimezone(zones.get(p.id)) }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

/** Days since the epoch for a YYYY-MM-DD, the rotation's clock. */
function epochDay(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

function dayMinus(day: string, days: number): string {
  return new Date((epochDay(day) - days) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The opted-in athletes in tonight's order: the stable id order, started at
 * an index the day picks. The start advances by the BUDGET each day, not by
 * one: tonight serves [s, s + budget) and defers the rest, so tomorrow must
 * start at s + budget for tonight's first deferred athlete to be first —
 * a shift of one would leave them last again. Deterministic, so a re-run
 * of the same night walks the same order (and its already-done rows skip
 * instantly).
 */
export function rotateForDay<T>(users: T[], day: string): T[] {
  if (users.length === 0) return users;
  const start = (epochDay(day) * MAX_WORK_ITEMS_PER_RUN) % users.length;
  return [...users.slice(start), ...users.slice(0, start)];
}

/**
 * Unfinished rows from earlier nights for these athletes — `pending` (a run
 * died mid-flight) or `failed` (the model or its JSON, twice) — within the
 * backlog window and strictly before `day`, oldest first. Today's own row,
 * whatever its state, is the main pass's to resume.
 */
export async function listBacklog(supabase: Admin, users: OptedIn[], day: string): Promise<WorkItem[]> {
  if (users.length === 0) return [];
  const byId = new Map(users.map(u => [u.userId, u]));
  const { data, error } = await supabase
    .from('coach_reflections')
    .select('user_id, day, status')
    .in('user_id', [...byId.keys()])
    .in('status', ['pending', 'failed'])
    .gte('day', dayMinus(day, BACKLOG_DAYS))
    .lt('day', day)
    .order('day', { ascending: true })
    .order('user_id', { ascending: true });
  if (error) throw new Error(`coach_reflections backlog fetch failed: ${error.message}`);
  return (data ?? [])
    .map(r => ({ user: byId.get(r.user_id)!, day: r.day }))
    .filter(w => w.user !== undefined);
}

/**
 * Days tonight's pass would step over. An athlete's day comes from their
 * wall clock at a fixed 05:00 UTC run, so when their offset moves east — US
 * Central at spring-forward, any eastward trip — tonight's day can be two
 * after last night's and the one between is never targeted. Such a day has
 * no row at all, so the backlog (which retries rows) cannot bring it back.
 * It is picked up here: no row for the day before tonight's, and a row for
 * the day before that, i.e. a gap in an otherwise reflected run. A first
 * night after opting in has no earlier row and is not backfilled.
 */
export async function listSkipped(supabase: Admin, tonight: WorkItem[]): Promise<WorkItem[]> {
  if (tonight.length === 0) return [];
  const days = tonight.map(w => w.day).sort();
  const { data, error } = await supabase
    .from('coach_reflections')
    .select('user_id, day')
    .in('user_id', tonight.map(w => w.user.userId))
    .gte('day', dayMinus(days[0], 2))
    .lt('day', days[days.length - 1]);
  if (error) throw new Error(`coach_reflections gap fetch failed: ${error.message}`);
  const have = new Set(((data ?? []) as Array<{ user_id: string; day: string }>).map(r => `${r.user_id}|${r.day}`));
  return tonight.flatMap(({ user, day }) => {
    const between = dayMinus(day, 1);
    return !have.has(`${user.userId}|${between}`) && have.has(`${user.userId}|${dayMinus(day, 2)}`)
      ? [{ user, day: between }]
      : [];
  });
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
  // The run's day: the rotation's clock and the backlog's horizon. Each
  // athlete's own day is dayFor(user) — the same unless their zone is behind
  // UTC, when it is the day before (the one still going is not reflected on).
  const day = dayParam ?? yesterdayUtc(now);
  const dayFor = (user: OptedIn) => dayParam ?? yesterdayIn(user.timeZone, now);
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
      const inputs = await fetchReflectionInputs(supabase, onlyUserId, dayFor(users[0]), users[0].timeZone);
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

  const tonight = rotateForDay(users, day).map(user => ({ user, day: dayFor(user) }));
  let backlog: WorkItem[];
  let skipped: WorkItem[];
  try {
    backlog = await listBacklog(supabase, users, day);
    // ?day= names one day on purpose; only the scheduled run fills gaps.
    skipped = dayParam === undefined ? await listSkipped(supabase, tonight) : [];
  } catch (err) {
    console.error('[reflection-cron] backlog listing failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to list the reflection backlog');
    return;
  }
  // An athlete behind UTC reflects on a day the backlog window also covers;
  // a pending or failed row for it runs once, in tonight's pass.
  const tonightKeys = new Set(tonight.map(w => `${w.user.userId}|${w.day}`));
  const work: WorkItem[] = [
    ...backlog.filter(w => !tonightKeys.has(`${w.user.userId}|${w.day}`)),
    ...skipped,
    ...tonight,
  ];

  const processed: Array<{ userId: string; day: string; action: string; memoriesProposed?: number; contractProposed?: boolean }> = [];
  const errors: Array<{ userId: string; day: string; error: string }> = [];
  let workBudget = MAX_WORK_ITEMS_PER_RUN;
  // One key read per athlete per run, whatever the number of items.
  const keys = new Map<string, string | null>();

  for (const { user, day: itemDay } of work) {
    const label = { userId: user.userId, day: itemDay };
    try {
      if (workBudget <= 0 || Date.now() - startedAt > WORK_BUDGET_MS) {
        processed.push({ ...label, action: 'deferred' });
        continue;
      }
      let apiKey = keys.get(user.userId);
      if (apiKey === undefined) {
        apiKey = await getAnthropicKey(supabase, user.userId);
        keys.set(user.userId, apiKey);
      }
      if (!apiKey) {
        // No key, no model call — and no row, so the night is reflected on
        // once a key is saved and the day is still within reach.
        processed.push({ ...label, action: 'skipped-no-key' });
        continue;
      }
      workBudget -= 1;
      // Every model call the reflection makes (the first ask and its one
      // retry) writes a coach_runs row, both under one request id.
      const instrumented = instrumentMessages(makeAnthropicClient(apiKey), supabase, {
        user_id: user.userId,
        mode: 'reflection',
        prompt_version: REFLECTION_PROMPT_VERSION,
        request_id: crypto.randomUUID(),
        client: 'cron',
      });
      let outcome: ReflectOutcome;
      try {
        outcome = await reflectForUser(supabase, {
          userId: user.userId,
          day: itemDay,
          timeZone: user.timeZone,
          model: resolveCoachModel(user.coachModel).id,
          client: instrumented.client,
        }, now);
      } finally {
        // The rows are written beside the calls, not by them: wait for them
        // before the function can return and be frozen.
        await instrumented.settled();
      }
      processed.push({
        ...label,
        action: outcome.action,
        memoriesProposed: outcome.memoriesProposed,
        contractProposed: outcome.contractProposed,
      });
      if (outcome.error) errors.push({ ...label, error: outcome.error });
    } catch (err) {
      // Per-athlete isolation: one failure must not stop the run.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[reflection-cron] ${user.userId} ${itemDay} failed:`, detail);
      errors.push({ ...label, error: detail });
    }
  }

  console.log(`[reflection-cron] ${day}: ${processed.length} item(s) (${backlog.length} from the backlog), ${errors.length} error(s)`);
  res.status(200).json({ day, processed, errors });
}
