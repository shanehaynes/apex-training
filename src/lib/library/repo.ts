import { supabase } from '../supabaseClient';
import type { CardioLogRow, SetLogRow } from '../db/types';
import type { NameDateRow } from './stats';

// Data access for the exercise library — reads only, on the anon client
// (SELECT-only RLS policies), like the tracker's history fetches. Offline
// (no Supabase) everything degrades to empty history: the library still
// lists definitions, just without performance data.

/**
 * Lightweight (name, date) pairs across all real logs, for the list view's
 * last-performed column. Two columns only — the full-row fetch stays
 * per-exercise on the detail page.
 */
export async function fetchLastPerformedRows(): Promise<NameDateRow[]> {
  if (!supabase) return [];
  const [sets, cardio] = await Promise.all([
    supabase.from('workout_set_logs').select('exercise_name,event_date').eq('is_autofilled', false).limit(10000),
    supabase.from('workout_cardio_logs').select('exercise_name,event_date').eq('is_autofilled', false).limit(10000),
  ]);
  return [
    ...((sets.data ?? []) as NameDateRow[]),
    ...((cardio.data ?? []) as NameDateRow[]),
  ];
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
      .limit(2000),
    supabase
      .from('workout_cardio_logs')
      .select('*')
      .in('exercise_name', spellings)
      .order('event_date', { ascending: false })
      .limit(2000),
  ]);
  return {
    setRows: (sets.data ?? []) as SetLogRow[],
    cardioRows: (cardio.data ?? []) as CardioLogRow[],
  };
}
