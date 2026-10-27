import { supabase } from '../supabaseClient';
import type { CardioLogRow, CompletionRow, SetLogRow, WorkoutSessionRow } from '../db/types';
import type { TrainingBlock } from '../../types/blocks';
import type { PeriodInputs, StatsPeriod } from '../review/types';
import { blockPeriod } from './period';
import { fetchAllRows } from '../db/pagination';

// Data access for block attainment. Reads go through the ANON client under
// RLS — no service role, no new endpoint — the same posture as
// src/lib/tracking/sessionRepo.ts.
//
// Deliberately NOT api/_lib/reviewData.ts fetchReviewInputs: that pages a
// user's ENTIRE log history because PR detection needs it, which is far too
// heavy for a view render. Set and cardio logs are still fetched back to the
// block start (PR lineage inside the block), but never the whole history.

export interface BlockLogs {
  completions: CompletionRow[];
  sessions: WorkoutSessionRow[];
  setLogs: SetLogRow[];
  cardioLogs: CardioLogRow[];
}

const EMPTY: BlockLogs = { completions: [], sessions: [], setLogs: [], cardioLogs: [] };

/**
 * Logs covering a block's window. Offline (supabase === null) yields nothing;
 * a failed query throws, so the caller can tell "no logs" from "no answer".
 * Paged (src/lib/db/pagination.ts): a 12-week block can pass max_rows in set
 * logs alone, and attainment would then under-report against real targets.
 */
export async function loadBlockLogs(
  { startDate, endDateExclusive }: Pick<TrainingBlock, 'startDate' | 'endDateExclusive'>,
  signal?: AbortSignal,
): Promise<BlockLogs> {
  const db = supabase;
  if (!db) return EMPTY;

  // Each ordered by its table's unique key (RLS fixes user_id), so the pages
  // are a total order.
  const [completions, sessions, setLogs, cardioLogs] = await Promise.all([
    fetchAllRows('block completions', (from, to) =>
      db
        .from('workout_completions')
        .select('*')
        .eq('is_completed', true)
        .gte('event_date', startDate)
        .lt('event_date', endDateExclusive)
        .order('event_id')
        .range(from, to), signal),
    fetchAllRows('block sessions', (from, to) =>
      db
        .from('workout_sessions')
        .select('*')
        .gte('event_date', startDate)
        .lt('event_date', endDateExclusive)
        .order('event_date')
        .order('event_id')
        .range(from, to), signal),
    fetchAllRows('block setLogs', (from, to) =>
      db
        .from('workout_set_logs')
        .select('*')
        .eq('is_autofilled', false)
        .eq('is_warmup', false)
        .gte('event_date', startDate)
        .lt('event_date', endDateExclusive)
        .order('event_date')
        .order('event_id')
        .order('section')
        .order('exercise_id')
        .order('set_number')
        .range(from, to), signal),
    fetchAllRows('block cardioLogs', (from, to) =>
      db
        .from('workout_cardio_logs')
        .select('*')
        .eq('is_autofilled', false)
        .gte('event_date', startDate)
        .lt('event_date', endDateExclusive)
        .order('event_date')
        .order('event_id')
        .order('section')
        .order('exercise_id')
        .range(from, to), signal),
  ]);

  return {
    completions: completions as CompletionRow[],
    sessions:    sessions as WorkoutSessionRow[],
    setLogs:     setLogs as SetLogRow[],
    cardioLogs:  cardioLogs as CardioLogRow[],
  };
}

/** Shape the fetched logs into the aggregation inputs. */
export function toPeriodInputs(block: TrainingBlock, logs: BlockLogs): PeriodInputs<StatsPeriod> {
  return { period: blockPeriod(block), ...logs };
}
