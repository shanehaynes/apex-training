import type { McpToolDef } from '../protocol.js';
import { ToolInputError } from '../protocol.js';
import { requireDate, requireDateRange, requireString } from '../args.js';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../data.js';
import { fetchAllPages } from '../../pagination.js';
import type { CardioLogRow, SetLogRow, WorkoutSessionRow } from '../../../../src/lib/db/types.js';
import type { Exercise, WorkoutEvent } from '../../../../src/types/workout.js';
import { classifySet, estimateOneRepMax } from '../../../../src/lib/tracking/records.js';
import { makeOccurrenceId } from '../../../../src/lib/schedule/occurrence.js';

// Calendar-facing tools: what is planned, and what actually happened in one
// workout. Occurrence expansion matches the calendar exactly (same pure
// expander the SPA uses).

const MAX_SCHEDULE_DAYS = 93;

function prescriptionEntry(e: Exercise) {
  return {
    name: e.name,
    category: e.category,
    sets: e.sets ?? null,
    reps: e.reps ?? null,
    duration: e.duration ?? null,
    weight: e.weight ?? null,
    rest: e.restPeriod ?? null,
    notes: e.notes ?? null,
  };
}

function loggedSet(row: SetLogRow) {
  const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
  return {
    section: row.section,
    exercise: row.exercise_name,
    set_number: row.set_number,
    weight: row.actual_weight,
    reps: row.actual_reps,
    duration: row.actual_duration,
    estimated_1rm: set?.kind === 'oneRM' ? Math.round(estimateOneRepMax(set.weight, set.reps)) : null,
    autofilled: row.is_autofilled,
  };
}

function loggedCardio(row: CardioLogRow) {
  return {
    exercise: row.exercise_name,
    duration_minutes: row.duration_minutes,
    distance: row.distance,
    elevation_gain: row.elevation_gain,
    avg_heart_rate: row.avg_heart_rate,
    autofilled: row.is_autofilled,
  };
}

export const getScheduleTool: McpToolDef = {
  name: 'get_schedule',
  description:
    'Planned and completed workouts in a date range (max 93 days). Recurring events are expanded to ' +
    'individual occurrences; each row carries the event_id + date pair that get_workout_detail expects.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Range start, YYYY-MM-DD (inclusive).' },
      end_date: { type: 'string', description: 'Range end, YYYY-MM-DD (inclusive).' },
    },
    required: ['start_date', 'end_date'],
  },
  async run(supabase, userId, args) {
    const { startDate, endDate } = requireDateRange(args, MAX_SCHEDULE_DAYS);
    const [{ occurrences }, completions] = await Promise.all([
      fetchExpandedSchedule(supabase, userId, endDate),
      fetchCompletionsInRange(supabase, userId, startDate, endDate),
    ]);
    const completedIds = new Set(completions.filter(c => c.is_completed).map(c => c.event_id));

    const rows = occurrences
      .filter(e => e.date >= startDate && e.date <= endDate)
      .map(e => ({
        date: e.date,
        event_id: e.id,
        title: e.title,
        type: e.type,
        start_time: e.startTime ?? null,
        end_time: e.endTime ?? null,
        duration_min: e.estimatedDuration,
        location: e.location ?? null,
        completed: completedIds.has(e.id),
      }));

    return { start_date: startDate, end_date: endDate, workouts: rows };
  },
};

export const getWorkoutDetailTool: McpToolDef = {
  name: 'get_workout_detail',
  description:
    'Full prescription and logged results (sets, cardio, session timing) for one workout occurrence. ' +
    'Use the event_id + date returned by get_schedule.',
  inputSchema: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'Occurrence id from get_schedule.' },
      date: { type: 'string', description: 'The occurrence date, YYYY-MM-DD.' },
    },
    required: ['event_id', 'date'],
  },
  async run(supabase, userId, args) {
    const eventId = requireString(args, 'event_id');
    const date = requireDate(args, 'date');

    const { occurrences } = await fetchExpandedSchedule(supabase, userId, date);
    // Accept the base id for a recurring series too — the occurrence id is
    // base__date, and an LLM will plausibly pass the base id it saw elsewhere.
    const occurrence: WorkoutEvent | undefined =
      occurrences.find(e => e.id === eventId && e.date === date) ??
      occurrences.find(e => e.id === makeOccurrenceId(eventId, date));
    if (!occurrence) {
      throw new ToolInputError(`No workout found for event_id "${eventId}" on ${date}. Use get_schedule to list occurrences.`);
    }
    const occurrenceId = occurrence.id;

    const [completionRes, sessionRes, setLogs, cardioLogs] = await Promise.all([
      supabase
        .from('workout_completions')
        .select('*')
        .eq('user_id', userId)
        .eq('event_id', occurrenceId)
        .maybeSingle(),
      supabase
        .from('workout_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('event_id', occurrenceId)
        .eq('event_date', occurrence.date)
        .maybeSingle(),
      fetchAllPages<SetLogRow>('workout_set_logs', (from, to) =>
        supabase
          .from('workout_set_logs')
          .select('*')
          .eq('user_id', userId)
          .eq('event_id', occurrenceId)
          .eq('event_date', occurrence.date)
          .order('section', { ascending: true })
          .order('exercise_id', { ascending: true })
          .order('set_number', { ascending: true })
          .range(from, to),
      ),
      fetchAllPages<CardioLogRow>('workout_cardio_logs', (from, to) =>
        supabase
          .from('workout_cardio_logs')
          .select('*')
          .eq('user_id', userId)
          .eq('event_id', occurrenceId)
          .eq('event_date', occurrence.date)
          .order('exercise_id', { ascending: true })
          .range(from, to),
      ),
    ]);

    const session = (sessionRes.data ?? null) as WorkoutSessionRow | null;
    const completion = completionRes.data as { is_completed: boolean; completed_at: string | null } | null;

    return {
      event: {
        event_id: occurrenceId,
        date: occurrence.date,
        title: occurrence.title,
        type: occurrence.type,
        start_time: occurrence.startTime ?? null,
        duration_min: occurrence.estimatedDuration,
        description: occurrence.description || null,
        difficulty: occurrence.difficulty ?? null,
        location: occurrence.location ?? null,
        cardio_targets: occurrence.cardioTargets ?? null,
        climbing_targets: occurrence.climbingTargets ?? null,
      },
      prescription: {
        warmup: (occurrence.warmup ?? []).map(prescriptionEntry),
        exercises: (occurrence.exercises ?? []).map(prescriptionEntry),
        cooldown: (occurrence.cooldown ?? []).map(prescriptionEntry),
      },
      completed: completion?.is_completed ?? false,
      completed_at: completion?.completed_at ?? null,
      session: session
        ? {
            started_at: session.started_at,
            finished_at: session.finished_at,
            total_duration_seconds: session.total_duration_seconds,
            coach_summary: session.coach_summary,
          }
        : null,
      logged: { sets: setLogs.map(loggedSet), cardio: cardioLogs.map(loggedCardio) },
    };
  },
};
