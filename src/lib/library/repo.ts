import { supabase } from '../supabaseClient';
import type { CardioLogRow, SetLogRow } from '../db/types';
import type { NameDateRow } from './stats';
import { fetchAllRows } from '../db/pagination';

// Data access for the exercise library — reads only, on the anon client
// (SELECT-only RLS policies), like the tracker's history fetches. Offline
// (no Supabase) everything degrades to empty history: the library still
// lists definitions, just without performance data. A failed query throws
// rather than reading as empty, so a caller never shows "no history" for
// history it could not load.

/**
 * Most recent log date per exercise name, for the list view's last-performed
 * column. The phase31 aggregate does the max() server-side: this used to pull
 * every (name, date) pair the user had ever logged — up to 20k rows over the
 * wire on every mount — to compute a few dozen. The full-row fetch stays
 * per-exercise on the detail page.
 *
 * No user filter here or in the RPC call: the function defaults to auth.uid()
 * and runs SECURITY INVOKER, so RLS scopes it exactly as the plain selects it
 * replaces were scoped.
 */
export async function fetchLastPerformedRows(): Promise<NameDateRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('last_performed_by_name');
  if (error) throw new Error(`last-performed load failed: ${error.message}`);
  return (data ?? []) as NameDateRow[];
}

/**
 * Full log history for one exercise, matched across every known spelling
 * (canonical + aliases) — the same widening the tracker's history fetch uses.
 * Paged (src/lib/db/pagination.ts): a single select stops at max_rows, and the
 * PR card would then show a partial best as all-time.
 */
export async function fetchExerciseHistory(
  spellings: string[],
  signal?: AbortSignal,
): Promise<{ setRows: SetLogRow[]; cardioRows: CardioLogRow[] }> {
  const db = supabase;
  if (!db || spellings.length === 0) return { setRows: [], cardioRows: [] };
  // Ordered by each table's unique key, ascending — the server readers'
  // order. It lists a session's sets as logged (stats keeps row order within
  // a date), and a set logged mid-drain sorts after the pages already read.
  const [setRows, cardioRows] = await Promise.all([
    fetchAllRows('set history', (from, to) =>
      db
        .from('workout_set_logs')
        .select('*')
        .in('exercise_name', spellings)
        .order('event_date')
        .order('event_id')
        .order('section')
        .order('exercise_id')
        .order('set_number')
        .range(from, to), signal),
    fetchAllRows('cardio history', (from, to) =>
      db
        .from('workout_cardio_logs')
        .select('*')
        .in('exercise_name', spellings)
        .order('event_date')
        .order('event_id')
        .order('section')
        .order('exercise_id')
        .range(from, to), signal),
  ]);
  return { setRows: setRows as SetLogRow[], cardioRows: cardioRows as CardioLogRow[] };
}
