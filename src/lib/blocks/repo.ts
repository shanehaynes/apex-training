import { supabase } from '../supabaseClient';
import type { CardioLogRow, CompletionRow, SetLogRow, WorkoutSessionRow } from '../db/types';
import type { TrainingBlock } from '../../types/blocks';
import type { PeriodInputs, StatsPeriod } from '../review/types';
import { blockPeriod } from './period';

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

/** Logs covering a block's window. Offline (supabase === null) yields nothing. */
export async function loadBlockLogs(block: TrainingBlock): Promise<BlockLogs> {
  if (!supabase) return EMPTY;
  const { startDate, endDateExclusive } = blockPeriod(block);

  const [completions, sessions, setLogs, cardioLogs] = await Promise.all([
    supabase
      .from('workout_completions')
      .select('*')
      .eq('is_completed', true)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive),
    supabase
      .from('workout_sessions')
      .select('*')
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive),
    supabase
      .from('workout_set_logs')
      .select('*')
      .eq('is_autofilled', false)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive)
      .order('event_date', { ascending: true }),
    supabase
      .from('workout_cardio_logs')
      .select('*')
      .eq('is_autofilled', false)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive)
      .order('event_date', { ascending: true }),
  ]);

  for (const [label, res] of Object.entries({ completions, sessions, setLogs, cardioLogs })) {
    if (res.error) console.warn(`[apex] block ${label} load failed:`, res.error.message);
  }

  return {
    completions: (completions.data ?? []) as CompletionRow[],
    sessions:    (sessions.data ?? []) as WorkoutSessionRow[],
    setLogs:     (setLogs.data ?? []) as SetLogRow[],
    cardioLogs:  (cardioLogs.data ?? []) as CardioLogRow[],
  };
}

/** Shape the fetched logs into the aggregation inputs. */
export function toPeriodInputs(block: TrainingBlock, logs: BlockLogs): PeriodInputs<StatsPeriod> {
  return { period: blockPeriod(block), ...logs };
}
