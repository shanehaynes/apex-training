import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { pickAllowed, COMPLETION_COLUMNS, COMPLETION_LOG_COLUMNS, SERVER_STAMPED_COLUMNS } from '../allowlist.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { TablesInsert } from '../../../src/lib/db/types.js';

// Completion state + the append-only completion log, extracted from
// api/_lib/handlers/completions.ts (W5b) so a coach-created retro-log can
// complete on creation the way the calendar's toggle does.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function recordCompletion(
  supabase: Admin,
  userId: string,
  completionRow: Record<string, unknown>,
  logRow: Record<string, unknown>,
): Promise<ServiceResult> {
  // workout_completion_log is the append-only source of truth for analytics,
  // so both row shapes are allowlisted: logged_at/updated_at are stamped
  // server-side and unknown columns are rejected — a caller cannot backdate
  // or fabricate history.
  const completion = pickAllowed(completionRow, COMPLETION_COLUMNS, SERVER_STAMPED_COLUMNS);
  const log = pickAllowed(logRow, COMPLETION_LOG_COLUMNS, SERVER_STAMPED_COLUMNS);
  const rejected = [...completion.rejected, ...log.rejected];
  if (rejected.length > 0) {
    console.error('[api/completions] rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown completion fields: ${rejected.join(', ')}`);
  }
  if (typeof completion.picked.event_id !== 'string' || typeof completion.picked.event_date !== 'string') {
    return fail(400, 'completionRow needs event_id and event_date');
  }
  if (log.picked.action !== 'complete' && log.picked.action !== 'uncomplete') {
    return fail(400, "logRow.action must be 'complete' or 'uncomplete'");
  }

  const now = new Date().toISOString();
  const [{ error: upsertErr }, { error: logErr }] = await Promise.all([
    supabase
      .from('workout_completions')
      .upsert(
        { ...completion.picked, user_id: userId, updated_at: now } as TablesInsert<'workout_completions'>,
        { onConflict: 'user_id,event_id' },
      ),
    supabase
      .from('workout_completion_log')
      .insert({ ...log.picked, user_id: userId } as TablesInsert<'workout_completion_log'>),
  ]);
  if (upsertErr) console.error('[api/completions] upsert failed:', upsertErr.message);
  if (logErr) console.error('[api/completions] log insert failed:', logErr.message);
  if (upsertErr || logErr) return fail(500, 'Failed to record completion');
  return succeed(undefined);
}
