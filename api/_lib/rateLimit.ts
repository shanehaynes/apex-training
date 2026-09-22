import type { VercelResponse } from '@vercel/node';
import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { sendReviewEmail } from './mailer.js';

// Per-user request throttles and a daily AI-mutation cap. Both checks FAIL
// OPEN: on any storage error we log loudly and allow the request, because
// for this app availability beats strictness and the JWT auth layer is
// still intact. Counters live in Postgres (api_request_counts + the
// bump_rate_limit RPC, see supabase/migrations/phase18_rate_limits.sql).
//
// Scope honesty: the AI cap keys off triggered_by, and what that is worth
// now depends on the route. The COACH path is server-stamped — tool
// execution moved off the browser in W5b (api/_lib/handlers/coachTool.ts),
// and api/_lib/coach/serverDeps.ts sets triggered_by: 'ai' on every mutation
// it makes, so no caller declares it there. It stays a CLIENT-declared field
// on /api/meals and /api/training-blocks, where the web and iOS clients only
// ever send 'user' — so every row the cap actually counts is one the server
// stamped itself, and a lying caller does not inflate the count, it opts out
// of it, contained only by the per-bucket request throttles below. Still a
// volume guard against a runaway loop, NOT a security boundary.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface RateLimitRule {
  windowSeconds: number;
  max: number;
}

export const RATE_LIMITS = {
  /** Each coach message costs 2 calls (tool turn + follow-up). */
  chat:    { windowSeconds: 600,  max: 30 },
  summary: { windowSeconds: 3600, max: 10 },
  /** Shared across events / event-instances / exercise-definitions / profile writes. */
  writes:  { windowSeconds: 3600, max: 120 },
  /** Tracker autosave (workout-sessions) — debounced saves during a long session add up. */
  tracker: { windowSeconds: 3600, max: 600 },
  /** ICS calendar feed, keyed by the token's resolved user. */
  feed:    { windowSeconds: 3600, max: 120 },
  /** Remote MCP endpoint, keyed by the access token's resolved user. */
  mcp:     { windowSeconds: 3600, max: 300 },
  /** Provider sync (COROS): one apply writes dozens of rows, so it gets its
   *  own bucket instead of draining the shared writes budget. */
  providerSync: { windowSeconds: 3600, max: 60 },
  /** Native-client read endpoints (/api/schedule, /api/query, analytics
   *  compute): these replace direct Supabase reads that had no throttle at
   *  all. Generous for refresh-on-foreground + realtime; a 30s poll would
   *  drain it, which is the point — never poll. */
  reads:   { windowSeconds: 600,  max: 300 },
  /** Coach thread persistence (/api/coach-conversations): hydrate on mount,
   *  then one append per completed turn and per tool_result flush. Sized
   *  between `reads` and `writes` — the appends ride along with /api/chat,
   *  which its own `chat` bucket already caps at 30 per 10 minutes, so this
   *  only has to be loose enough never to be the reason a saved thread
   *  silently stops saving. */
  conversations: { windowSeconds: 600, max: 200 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

// Fail-open accounting: a Postgres hiccup silently disables every limiter,
// so each occurrence is counted and logged with a stable, grep-able tag.
// Vercel log alerts can key on "RATE-LIMIT-FAIL-OPEN".
let failOpenCount = 0;

export function rateLimitFailOpenCount(): number {
  return failOpenCount;
}

function logFailOpen(check: string, err: unknown): void {
  failOpenCount += 1;
  console.error(
    `[rateLimit] RATE-LIMIT-FAIL-OPEN #${failOpenCount} — ${check} check failed, allowing request:`,
    err instanceof Error ? err.message : err,
  );
}

/**
 * Fixed-window per-user limit. Returns false (with a 429 already sent)
 * when the caller is over the bucket's limit.
 */
export async function enforceRateLimit(
  supabase: Admin,
  res: VercelResponse,
  userId: string,
  bucket: RateLimitBucket,
): Promise<boolean> {
  const rule: RateLimitRule = RATE_LIMITS[bucket];
  try {
    const { data, error } = await supabase.rpc('bump_rate_limit', {
      p_user_id: userId,
      p_bucket: bucket,
      p_window_seconds: rule.windowSeconds,
    });
    if (error) throw new Error(error.message);
    if (typeof data === 'number' && data > rule.max) {
      res.setHeader('Retry-After', String(rule.windowSeconds));
      res.status(429).send('Too many requests — try again in a few minutes.');
      return false;
    }
  } catch (err) {
    logFailOpen(bucket, err);
  }
  return true;
}

export const AI_DAILY_MUTATION_CAP = 200;

/**
 * Daily cap on coach-driven mutations, counted from the audit logs
 * (triggered_by = 'ai' rows since UTC midnight). Call only for requests
 * that are NOT explicitly user-triggered. On the first breach of the day
 * (count exactly at the cap) a best-effort alert email goes to the user.
 */
export async function enforceAiMutationCap(
  supabase: Admin,
  res: VercelResponse,
  userId: string,
  cap: number = AI_DAILY_MUTATION_CAP,
): Promise<boolean> {
  if (await aiMutationCapReached(supabase, userId, cap)) {
    res.setHeader('Retry-After', '3600');
    res.status(429).send('Daily AI mutation cap reached.');
    return false;
  }
  return true;
}

/**
 * The cap check without the response: true when today's AI-attributed
 * mutations have reached the cap (and the first-breach alert has been
 * sent). Fails OPEN — a storage error reads as "not reached".
 */
export async function aiMutationCapReached(
  supabase: Admin,
  userId: string,
  cap: number = AI_DAILY_MUTATION_CAP,
): Promise<boolean> {
  try {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const since = midnight.toISOString();

    const [events, definitions, blocks, meals] = await Promise.all([
      supabase
        .from('event_mutations_log')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('triggered_by', 'ai')
        .gte('logged_at', since),
      supabase
        .from('definition_mutations_log')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('triggered_by', 'ai')
        .gte('logged_at', since),
      supabase
        .from('block_mutations_log')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('triggered_by', 'ai')
        .gte('logged_at', since),
      supabase
        .from('meal_mutations_log')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('triggered_by', 'ai')
        .gte('logged_at', since),
    ]);
    if (events.error) throw new Error(events.error.message);
    if (definitions.error) throw new Error(definitions.error.message);
    if (blocks.error) throw new Error(blocks.error.message);
    // Tolerated (fail open, like the outer catch): the phase23 table may not
    // exist yet — the other three logs still enforce the cap.
    if (meals.error) console.error('[rateLimit] meal log count failed (ignoring):', meals.error.message);

    const total = (events.count ?? 0) + (definitions.count ?? 0) + (blocks.count ?? 0) + (meals.count ?? 0);
    if (total >= cap) {
      // total === cap only on the first blocked request of the day — the
      // equality check is the alert dedupe (good enough per-user).
      if (total === cap) await alertCapHit(supabase, userId, cap);
      return true;
    }
  } catch (err) {
    logFailOpen('AI mutation cap', err);
  }
  return false;
}

async function alertCapHit(supabase: Admin, userId: string, cap: number): Promise<void> {
  try {
    const { data } = await supabase.auth.admin.getUserById(userId);
    const to = data?.user?.email;
    if (!to) return;
    const text =
      `The AI coach hit its daily mutation cap (${cap} schedule changes since UTC midnight) ` +
      `and further coach-driven changes are blocked until tomorrow. If you didn't expect this ` +
      `much activity, review Coach activity in your profile.`;
    await sendReviewEmail({
      to,
      subject: 'Apex Training: daily AI mutation cap reached',
      text,
      html: `<p>${text}</p>`,
    });
  } catch (err) {
    console.error('[rateLimit] cap alert email failed:', err instanceof Error ? err.message : err);
  }
}
