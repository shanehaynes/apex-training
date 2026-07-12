import type { CompletionLogRow, CompletionRow, WorkoutEventRow } from '../db/types';
import type { WorkoutEvent, WorkoutType } from '../../types/workout';
import { ruleFromLegacyColumns } from '../recurrence';

// ─── Row ↔ WorkoutEvent mapping ───────────────────────────────────────────────
// Pure converters between the app's camelCase WorkoutEvent and the DB's
// snake_case workout_events columns.

type EventRowInsert = Omit<WorkoutEventRow, 'created_at' | 'updated_at'>;

export function rowToEvent(row: WorkoutEventRow): WorkoutEvent {
  return {
    id:                row.id,
    type:              row.type as WorkoutType,
    title:             row.title,
    subtitle:          row.subtitle ?? undefined,
    date:              row.date,
    startTime:         row.start_time ?? undefined,
    endTime:           row.end_time ?? undefined,
    estimatedDuration: row.estimated_duration,
    description:       row.description,
    warmup:            (row.warmup ?? []) as WorkoutEvent['warmup'],
    exercises:         (row.exercises ?? []) as WorkoutEvent['exercises'],
    cooldown:          (row.cooldown ?? []) as WorkoutEvent['cooldown'],
    difficulty:        row.difficulty as WorkoutEvent['difficulty'],
    location:          row.location ?? undefined,
    coverImageUrl:     row.cover_image_url ?? undefined,
    cardioTargets:     (row.cardio_targets ?? undefined) as WorkoutEvent['cardioTargets'],
    tags:              row.tags ?? [],
    equipment:         row.equipment ?? [],
    isCompleted:       false,
    isRecurring:       row.is_recurring,
    // recurrence_rule is canonical; rows the SQL backfill hasn't reached fall
    // back to a rule derived from the deprecated columns (null for 'custom').
    recurrenceRule:    row.recurrence_rule
      ?? ruleFromLegacyColumns(row.recurring_frequency, row.recurring_days, row.recurring_end_date)
      ?? undefined,
    recurringPattern:  row.recurring_frequency
      ? {
          frequency:  row.recurring_frequency as 'daily' | 'weekly' | 'custom',
          daysOfWeek: row.recurring_days ?? undefined,
          endDate:    row.recurring_end_date ?? undefined,
        }
      : undefined,
  };
}

// One converter per WorkoutEvent field that maps onto workout_events columns.
// eventToRow and eventFieldsToRow both read this table, so the camelCase ↔
// snake_case knowledge exists exactly once. (id and the recurringPattern →
// legacy-column split are handled separately in eventToRow.)
const EVENT_FIELDS: {
  [K in keyof WorkoutEvent]?: (value: WorkoutEvent[K] | undefined) => Partial<EventRowInsert>;
} = {
  type:              v => ({ type: v as string }),
  title:             v => ({ title: v as string }),
  subtitle:          v => ({ subtitle: v ?? null }),
  date:              v => ({ date: v as string }),
  startTime:         v => ({ start_time: v ?? null }),
  endTime:           v => ({ end_time: v ?? null }),
  estimatedDuration: v => ({ estimated_duration: v as number }),
  description:       v => ({ description: v as string }),
  warmup:            v => ({ warmup: (v ?? []) as unknown[] }),
  exercises:         v => ({ exercises: (v ?? []) as unknown[] }),
  cooldown:          v => ({ cooldown: (v ?? []) as unknown[] }),
  difficulty:        v => ({ difficulty: v as number }),
  location:          v => ({ location: v ?? null }),
  coverImageUrl:     v => ({ cover_image_url: v ?? null }),
  // Key omitted when unset so inserts keep working before the phase 9
  // cardio_targets column migration has been applied.
  cardioTargets:     v => (v === undefined ? {} : { cardio_targets: v }),
  tags:              v => ({ tags: v ?? [] }),
  equipment:         v => ({ equipment: v ?? [] }),
  isRecurring:       v => ({ is_recurring: v as boolean }),
  recurrenceRule:    v => ({ recurrence_rule: v ?? null }),
};

const EVENT_FIELD_ENTRIES = Object.entries(EVENT_FIELDS) as [
  keyof WorkoutEvent,
  (value: unknown) => Partial<EventRowInsert>,
][];

export function eventToRow(
  e: Partial<WorkoutEvent> & Pick<WorkoutEvent, 'id' | 'type' | 'title' | 'date' | 'estimatedDuration' | 'difficulty' | 'isRecurring' | 'exercises' | 'tags' | 'description' | 'isCompleted'>,
): EventRowInsert {
  const row = { id: e.id } as EventRowInsert;
  for (const [key, convert] of EVENT_FIELD_ENTRIES) {
    Object.assign(row, convert(e[key]));
  }
  row.recurring_frequency = e.recurringPattern?.frequency ?? null;
  row.recurring_days      = e.recurringPattern?.daysOfWeek ?? null;
  row.recurring_end_date  = e.recurringPattern?.endDate ?? null;
  return row;
}

/** Only the columns for fields actually present — for PATCH bodies. */
export function eventFieldsToRow(
  fields: Partial<Omit<WorkoutEvent, 'id' | 'isCompleted'>>,
): Partial<EventRowInsert> {
  const row: Partial<EventRowInsert> = {};
  for (const [key, convert] of EVENT_FIELD_ENTRIES) {
    const value = fields[key as keyof typeof fields];
    if (value === undefined) continue;
    Object.assign(row, convert(value));
  }
  return row;
}

// ─── Completion rows ──────────────────────────────────────────────────────────

export function buildCompletionRows(
  event: WorkoutEvent,
  isNowCompleted: boolean,
): { completionRow: CompletionRow; logRow: CompletionLogRow } {
  const completionRow: CompletionRow = {
    event_id:         event.id,
    event_date:       event.date,
    event_type:       event.type,
    event_title:      event.title,
    duration_minutes: event.estimatedDuration ?? null,
    is_completed:     isNowCompleted,
    completed_at:     isNowCompleted ? new Date().toISOString() : null,
    updated_at:       new Date().toISOString(),
  };
  const logRow: CompletionLogRow = {
    event_id:         event.id,
    event_date:       event.date,
    event_type:       event.type,
    event_title:      event.title,
    duration_minutes: event.estimatedDuration ?? null,
    action:           isNowCompleted ? 'complete' : 'uncomplete',
  };
  return { completionRow, logRow };
}
