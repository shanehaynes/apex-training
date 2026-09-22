import type { TablesInsert } from '../../src/lib/db/database.types.js';
import type { getSupabaseAdmin } from './supabaseAdmin.js';

// One row per coach turn (supabase/migrations/phase45_coach_runs.sql). The
// numbers api/chat.ts currently logs to stdout and loses, kept where they can
// be grouped by user, model and prompt version.
//
// FAILS OPEN, like the rate limiter next door: telemetry must never be the
// reason a coach turn fails. The row is written after the stream has already
// closed, so by the time anything here can go wrong the user has their
// answer — losing the row costs a data point; throwing would cost the request
// its clean end. Errors are logged under a stable, grep-able tag and
// swallowed.
//
// WHAT NEVER GOES IN A ROW: prompt text, message content, tool arguments, key
// material. The migration's header says why; the type below is the only place
// that could quietly widen, so widen it deliberately.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The insert shape, straight from the generated schema types. */
export type CoachRunInsert = TablesInsert<'coach_runs'>;

/**
 * Record one coach turn. Resolves either way and never throws.
 */
export async function recordCoachRun(admin: Admin, row: CoachRunInsert): Promise<void> {
  try {
    const { error } = await admin.from('coach_runs').insert(row);
    if (error) console.error('[api/coach-runs] insert failed:', error.message);
  } catch (err) {
    // A rejection rather than an `error` payload — no network, a bad URL, an
    // aborted socket. Same outcome: log once, return.
    console.error('[api/coach-runs] insert failed:', err instanceof Error ? err.message : err);
  }
}
