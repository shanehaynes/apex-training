import { parseISO } from 'date-fns';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchAllPages } from '../pagination.js';
import type {
  CardioLogRow,
  CompletionRow,
  ExerciseDefinitionRow,
  RecurringExceptionRow,
  SetLogRow,
  WorkoutEventRow,
} from '../../../src/lib/db/types.js';
import type { WorkoutEvent, ExerciseDefinition } from '../../../src/types/workout.js';
import type { OccurrenceOverride } from '../../../src/lib/schedule/types.js';
import { rowToEvent } from '../../../src/lib/schedule/mapping.js';
import {
  buildAliasIndex,
  canonicalizeLogNames,
  resolveEventExercises,
  rowToDefinition,
  type AliasIndex,
} from '../../../src/lib/schedule/definitions.js';
import { makeOccurrenceId } from '../../../src/lib/schedule/occurrence.js';
import { expandRecurringEvents } from '../../../src/lib/schedule/expand.js';

// Service-role data access for the MCP tools. Every query filters by the
// explicit user_id resolved from the bearer token — same posture as
// reviewData.ts (the service-role client bypasses RLS).

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function fetchDefinitionRows(supabase: Admin, userId: string): Promise<ExerciseDefinitionRow[]> {
  return fetchAllPages<ExerciseDefinitionRow>('exercise_definitions', (from, to) =>
    supabase
      .from('exercise_definitions')
      .select('*')
      .eq('user_id', userId)
      .order('canonical_name', { ascending: true })
      .range(from, to),
  );
}

export function aliasIndexOf(defs: ExerciseDefinitionRow[]): AliasIndex {
  return buildAliasIndex(defs.map(d => ({ canonicalName: d.canonical_name, aliases: d.aliases ?? [] })));
}

export interface ExpandedSchedule {
  /** Flat occurrence list, library references resolved, sorted by date. */
  occurrences: WorkoutEvent[];
  definitions: Map<string, ExerciseDefinition>;
}

/**
 * Base events + exceptions → the flat occurrence list, exactly as the
 * calendar computes it (ScheduleContext), anchored at `horizonAnchor` so
 * open-ended recurrences cover the requested window (+366 days).
 */
export async function fetchExpandedSchedule(
  supabase: Admin,
  userId: string,
  horizonAnchor: string,
): Promise<ExpandedSchedule> {
  const [eventRows, exceptionRows, definitionRows] = await Promise.all([
    fetchAllPages<WorkoutEventRow>('workout_events', (from, to) =>
      supabase.from('workout_events').select('*').eq('user_id', userId).order('date', { ascending: true }).range(from, to),
    ),
    fetchAllPages<RecurringExceptionRow>('recurring_exceptions', (from, to) =>
      supabase.from('recurring_exceptions').select('*').eq('user_id', userId).order('skipped_date', { ascending: true }).range(from, to),
    ),
    fetchDefinitionRows(supabase, userId),
  ]);

  const definitions = new Map(definitionRows.map(r => [r.id, rowToDefinition(r)]));

  // Same exception-map construction as ScheduleContext: null = skip, an
  // override = the occurrence moved.
  const exceptions = new Map<string, OccurrenceOverride | null>();
  for (const r of exceptionRows) {
    const hasOverride = r.override_date || r.override_start_time || r.override_end_time;
    exceptions.set(
      makeOccurrenceId(r.event_id, r.skipped_date),
      hasOverride
        ? {
            date: r.override_date ?? undefined,
            startTime: r.override_start_time ?? undefined,
            endTime: r.override_end_time ?? undefined,
          }
        : null,
    );
  }

  const resolvedBase = eventRows.map(row => resolveEventExercises(rowToEvent(row), definitions));
  return { occurrences: expandRecurringEvents(resolvedBase, exceptions, parseISO(horizonAnchor)), definitions };
}

export async function fetchCompletionsInRange(
  supabase: Admin,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<CompletionRow[]> {
  return fetchAllPages<CompletionRow>('workout_completions', (from, to) =>
    supabase
      .from('workout_completions')
      .select('*')
      .eq('user_id', userId)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .order('event_date', { ascending: true })
      .order('event_id', { ascending: true })
      .range(from, to),
  );
}

export interface CanonicalHistory {
  setLogs: SetLogRow[];
  cardioLogs: CardioLogRow[];
  aliasIndex: AliasIndex;
}

/**
 * Full non-autofilled log history, names unified through the alias index so a
 * renamed exercise keeps one PR lineage. Full-history by design: bests are
 * wrong if the past is truncated.
 */
export async function fetchCanonicalHistory(supabase: Admin, userId: string): Promise<CanonicalHistory> {
  const [setLogs, cardioLogs, defs] = await Promise.all([
    fetchAllPages<SetLogRow>('workout_set_logs', (from, to) =>
      supabase
        .from('workout_set_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('is_autofilled', false)
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
        .order('event_date', { ascending: true })
        .order('event_id', { ascending: true })
        .order('exercise_id', { ascending: true })
        .range(from, to),
    ),
    fetchDefinitionRows(supabase, userId),
  ]);

  const aliasIndex = aliasIndexOf(defs);
  return {
    setLogs: canonicalizeLogNames(setLogs, aliasIndex),
    cardioLogs: canonicalizeLogNames(cardioLogs, aliasIndex),
    aliasIndex,
  };
}

/** Today's date (UTC) as YYYY-MM-DD — the server has no user timezone. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
