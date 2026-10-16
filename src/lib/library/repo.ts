import { supabase } from '../supabaseClient';
import type { CardioLogRow, SetLogRow } from '../db/types';
import type { NameDateRow } from './stats';

// Data access for the exercise library — reads only, on the anon client
// (SELECT-only RLS policies), like the tracker's history fetches. Offline
// (no Supabase) everything degrades to empty history: the library still
// lists definitions, just without performance data. A failed query throws
// rather than reading as empty, so a caller never shows "no history" for
// history it could not load.

// PostgREST's max_rows (1000 locally in supabase/config.toml, and Supabase's
// hosted default) caps every response, so one select silently drops history
// past the newest 1000 rows — and the PR card then shows a partial best as
// all-time. History is drained page by page instead, as api/_lib/pagination.ts
// does server-side. A page shorter than PAGE_SIZE is the last one.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label} load failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

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
  const db = supabase;
  if (!db || spellings.length === 0) return { setRows: [], cardioRows: [] };
  // `id` breaks event_date ties so the pages are a total order: without it a
  // set could sit on two pages, or on neither.
  const [setRows, cardioRows] = await Promise.all([
    fetchAllRows('set history', (from, to) =>
      db
        .from('workout_set_logs')
        .select('*')
        .in('exercise_name', spellings)
        .order('event_date', { ascending: false })
        .order('id')
        .range(from, to)),
    fetchAllRows('cardio history', (from, to) =>
      db
        .from('workout_cardio_logs')
        .select('*')
        .in('exercise_name', spellings)
        .order('event_date', { ascending: false })
        .order('id')
        .range(from, to)),
  ]);
  return { setRows: setRows as SetLogRow[], cardioRows: cardioRows as CardioLogRow[] };
}
