import { supabase } from '../supabaseClient';
import type { CardioLogRow, SetLogRow } from '../db/types';
import type { NameDateRow } from './stats';

// Data access for the exercise library — reads only, on the anon client
// (SELECT-only RLS policies), like the tracker's history fetches. Offline
// (no Supabase) everything degrades to empty history: the library still
// lists definitions, just without performance data. A failed query throws
// rather than reading as empty, so a caller never shows "no history" for
// history it could not load.

// Per-table bound on one exercise's history fetch. No reason was recorded when
// it landed (519f5707); PostgREST's max_rows (1000, supabase/config.toml) caps
// each response below it anyway.
const HISTORY_ROW_CAP = 2000;

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
 */
export async function fetchExerciseHistory(
  spellings: string[],
): Promise<{ setRows: SetLogRow[]; cardioRows: CardioLogRow[] }> {
  if (!supabase || spellings.length === 0) return { setRows: [], cardioRows: [] };
  const [sets, cardio] = await Promise.all([
    supabase
      .from('workout_set_logs')
      .select('*')
      .in('exercise_name', spellings)
      .order('event_date', { ascending: false })
      .limit(HISTORY_ROW_CAP),
    supabase
      .from('workout_cardio_logs')
      .select('*')
      .in('exercise_name', spellings)
      .order('event_date', { ascending: false })
      .limit(HISTORY_ROW_CAP),
  ]);
  if (sets.error) throw new Error(`set history load failed: ${sets.error.message}`);
  if (cardio.error) throw new Error(`cardio history load failed: ${cardio.error.message}`);
  return {
    setRows: (sets.data ?? []) as SetLogRow[],
    cardioRows: (cardio.data ?? []) as CardioLogRow[],
  };
}
