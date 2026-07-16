import type { getSupabaseAdmin } from './supabaseAdmin.js';
import type { CardioLogRow, CompletionRow, ReviewRow, SetLogRow, WorkoutSessionRow } from '../../src/lib/db/types.js';
import { buildAliasIndex, canonicalizeLogNames } from '../../src/lib/schedule/definitions.js';
import type { PeriodType, ReviewInputs, ReviewPeriod } from '../../src/lib/review/types.js';

// Data access for the review cron — the only module that knows the review
// queries. Runs on the service-role client (no user JWT in cron context),
// so every query filters by an explicit user_id.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const PAGE_SIZE = 1000;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Drain a query page by page. Supabase caps unbounded selects at 1000 rows,
 * and PR detection scans a user's full log history — silently truncated
 * history would fabricate PRs.
 */
async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label} fetch failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function fetchReviewInputs(supabase: Admin, userId: string, period: ReviewPeriod): Promise<ReviewInputs> {
  const [completions, sessions, setLogs, cardioLogs, defs] = await Promise.all([
    fetchAllPages<CompletionRow>('workout_completions', (from, to) =>
      supabase
        .from('workout_completions')
        .select('*')
        .eq('user_id', userId)
        .eq('is_completed', true)
        .gte('event_date', period.startDate)
        .lt('event_date', period.endDateExclusive)
        .order('event_date', { ascending: true })
        .order('event_id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<WorkoutSessionRow>('workout_sessions', (from, to) =>
      supabase
        .from('workout_sessions')
        .select('*')
        .eq('user_id', userId)
        .gte('event_date', period.startDate)
        .lt('event_date', period.endDateExclusive)
        .order('event_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    // Full history up to the period end: PRs compare against everything prior.
    fetchAllPages<SetLogRow>('workout_set_logs', (from, to) =>
      supabase
        .from('workout_set_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('is_autofilled', false)
        .lt('event_date', period.endDateExclusive)
        .order('event_date', { ascending: true })
        .order('event_id', { ascending: true })
        .order('exercise_id', { ascending: true })
        .order('set_number', { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<CardioLogRow>('workout_cardio_logs', (from, to) =>
      supabase
        .from('workout_cardio_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('is_autofilled', false)
        .lt('event_date', period.endDateExclusive)
        .order('event_date', { ascending: true })
        .order('event_id', { ascending: true })
        .order('exercise_id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<{ canonical_name: string; aliases: string[] | null }>('exercise_definitions', (from, to) =>
      supabase
        .from('exercise_definitions')
        .select('canonical_name, aliases')
        .eq('user_id', userId)
        .order('canonical_name', { ascending: true })
        .range(from, to),
    ),
  ]);

  // Unify pre-rename spellings so a renamed exercise doesn't produce phantom
  // "first-ever" logs or split PR lineages.
  const aliasIndex = buildAliasIndex(defs.map(d => ({ canonicalName: d.canonical_name, aliases: d.aliases ?? [] })));

  return {
    period,
    completions,
    sessions,
    setLogs: canonicalizeLogNames(setLogs, aliasIndex),
    cardioLogs: canonicalizeLogNames(cardioLogs, aliasIndex),
  };
}

// ─── Recipients ───────────────────────────────────────────────────────────────
// profiles has no email column — addresses live in auth.users, so recipients
// come from the admin listUsers API joined with profiles for display names.

export interface Recipient {
  userId: string;
  email: string | null;
  displayName: string;
}

export async function listRecipients(supabase: Admin): Promise<Recipient[]> {
  const emails = new Map<string, string | null>();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const user of data.users) emails.set(user.id, user.email ?? null);
    if (data.users.length < 200) break;
  }

  const { data: profiles, error } = await supabase.from('profiles').select('id, display_name');
  if (error) throw new Error(`profiles fetch failed: ${error.message}`);

  return (profiles ?? [])
    .map(p => ({
      userId: p.id as string,
      email: emails.get(p.id as string) ?? null,
      displayName: (p.display_name as string) || 'athlete',
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

// ─── Review-row CRUD ──────────────────────────────────────────────────────────

export async function getReview(
  supabase: Admin,
  userId: string,
  periodType: PeriodType,
  isoYear: number,
  monthIndex: number | undefined,
): Promise<ReviewRow | null> {
  let query = supabase
    .from('reviews')
    .select('*')
    .eq('user_id', userId)
    .eq('period_type', periodType)
    .eq('iso_year', isoYear);
  query = monthIndex === undefined ? query.is('month_index', null) : query.eq('month_index', monthIndex);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`reviews lookup failed: ${error.message}`);
  return (data as ReviewRow | null) ?? null;
}

export interface CreateReviewParams {
  userId: string;
  periodType: PeriodType;
  isoYear: number;
  monthIndex?: number;
  stats: unknown;
  emailSkippedReason?: 'no-activity' | 'no-email';
}

export async function createReview(supabase: Admin, params: CreateReviewParams): Promise<ReviewRow> {
  const { data, error } = await supabase
    .from('reviews')
    .insert({
      user_id: params.userId,
      period_type: params.periodType,
      iso_year: params.isoYear,
      month_index: params.monthIndex ?? null,
      stats: params.stats,
      email_skipped_reason: params.emailSkippedReason ?? null,
    })
    .select('*')
    .single();
  if (error) {
    // Unique violation: another run already created it — reuse that row.
    if ((error as { code?: string }).code === '23505') {
      const existing = await getReview(supabase, params.userId, params.periodType, params.isoYear, params.monthIndex);
      if (existing) return existing;
    }
    throw new Error(`reviews insert failed: ${error.message}`);
  }
  return data as ReviewRow;
}

/** Remove a stored review so a forced manual run regenerates and re-sends it. */
export async function deleteReview(
  supabase: Admin,
  userId: string,
  periodType: PeriodType,
  isoYear: number,
  monthIndex: number | undefined,
): Promise<void> {
  let query = supabase
    .from('reviews')
    .delete()
    .eq('user_id', userId)
    .eq('period_type', periodType)
    .eq('iso_year', isoYear);
  query = monthIndex === undefined ? query.is('month_index', null) : query.eq('month_index', monthIndex);
  const { error } = await query;
  if (error) throw new Error(`reviews delete failed: ${error.message}`);
}

export async function saveCommentary(supabase: Admin, reviewId: string, commentary: string): Promise<void> {
  const { error } = await supabase
    .from('reviews')
    .update({ ai_commentary: commentary, updated_at: new Date().toISOString() })
    .eq('id', reviewId);
  if (error) throw new Error(`reviews commentary update failed: ${error.message}`);
}

export async function markEmailSent(supabase: Admin, reviewId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('reviews')
    .update({ email_sent_at: now, updated_at: now })
    .eq('id', reviewId);
  if (error) throw new Error(`reviews sent update failed: ${error.message}`);
}

export async function markEmailSkipped(
  supabase: Admin,
  reviewId: string,
  reason: 'no-activity' | 'no-email',
): Promise<void> {
  const { error } = await supabase
    .from('reviews')
    .update({ email_skipped_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', reviewId);
  if (error) throw new Error(`reviews skip update failed: ${error.message}`);
}
