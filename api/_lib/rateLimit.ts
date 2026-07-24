import type { VercelResponse } from '@vercel/node';
import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { sendReviewEmail } from './mailer.js';

// Per-user request throttles and a daily AI-mutation cap — the volume
// backstop for the coach. Both checks FAIL OPEN: on any storage error we
// log loudly and allow the request, because for this app availability
// beats strictness and the JWT auth layer is still intact. Counters live
// in Postgres (api_request_counts + the bump_rate_limit RPC, see
// supabase/migrations/phase18_rate_limits.sql) — no extra infra.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface RateLimitRule {
  windowSeconds: number;
  max: number;
}

export const RATE_LIMITS = {
  /** Each coach message costs 2 calls (tool turn + follow-up). */
  chat:    { windowSeconds: 600,  max: 30 },
  summary: { windowSeconds: 3600, max: 10 },
  /** Shared across events / event-instances / exercise-definitions writes. */
  writes:  { windowSeconds: 3600, max: 120 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

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
    console.error(`[rateLimit] ${bucket} check failed (allowing):`, err instanceof Error ? err.message : err);
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
  try {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const since = midnight.toISOString();

    const [events, definitions] = await Promise.all([
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
    ]);
    if (events.error) throw new Error(events.error.message);
    if (definitions.error) throw new Error(definitions.error.message);

    const total = (events.count ?? 0) + (definitions.count ?? 0);
    if (total >= cap) {
      // total === cap only on the first blocked request of the day — the
      // equality check is the alert dedupe (good enough per-user).
      if (total === cap) await alertCapHit(supabase, userId, cap);
      res.setHeader('Retry-After', '3600');
      res.status(429).send('Daily AI mutation cap reached.');
      return false;
    }
  } catch (err) {
    console.error('[rateLimit] AI mutation cap check failed (allowing):', err instanceof Error ? err.message : err);
  }
  return true;
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
