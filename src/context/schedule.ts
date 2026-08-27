import { createContext, useContext } from 'react';
import type { ExerciseDefinition, WorkoutEvent, WorkoutTemplate } from '../types/workout';
import type { CreateDefinitionInput, CreateEventInput, OccurrenceOverride, SaveWorkoutTemplateInput, UpdateDefinitionInput, UpdateEventInput } from '../lib/schedule/types';

// Context object + hook live apart from the provider so ScheduleContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScheduleContextValue {
  events: WorkoutEvent[];
  /** Exercise library, keyed by definition id. Empty offline — entries then render their snapshots. */
  definitions: Map<string, ExerciseDefinition>;
  isSyncing: boolean;
  isEventsLoading: boolean;
  /** Manual refetch — for flows that must not wait on the realtime channel (e.g. template copy). */
  refreshEvents: () => Promise<void>;
  /** Manual completion refetch — realtime doesn't cover workout_completions (e.g. provider sync). */
  refreshCompletions: () => Promise<void>;
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
  toggleCompletion: (id: string) => void;
  /** Idempotent completion set — no-op when already in the desired state. */
  setCompletion: (id: string, completed: boolean) => void;
  createEvent: (input: CreateEventInput) => Promise<{ id: string } | null>;
  updateEvent: (input: UpdateEventInput) => Promise<boolean>;
  deleteEvent: (id: string, triggeredBy?: 'user' | 'ai') => Promise<boolean>;
  deleteEventInstance: (baseId: string, date: string, triggeredBy?: 'user' | 'ai') => Promise<boolean>;
  /** Delete a single occurrence by the id the UI holds (base or expanded). */
  deleteOccurrence: (id: string) => Promise<boolean>;
  /**
   * Move a single event to a new date and/or time. One-off events are patched
   * directly; a recurring occurrence gets a per-occurrence override so the
   * rest of the series is untouched.
   */
  rescheduleEvent: (id: string, fields: OccurrenceOverride, triggeredBy?: 'user' | 'ai') => Promise<boolean>;
  /**
   * "Edit this event only" on a recurring occurrence: materialize it as a
   * standalone event carrying `fields`, skip it on the series, and relabel
   * anything already logged to the new id. Permanent — the day no longer
   * follows the series.
   */
  detachOccurrence: (id: string, fields: Partial<Omit<WorkoutEvent, 'id' | 'isCompleted'>>, triggeredBy?: 'user' | 'ai') => Promise<{ id: string } | null>;
  /** Add a movement to the exercise library. */
  createDefinition: (input: CreateDefinitionInput) => Promise<{ id: string } | null>;
  /** Edit library-tier fields; a canonicalName change auto-appends the old name as an alias server-side. */
  updateDefinition: (input: UpdateDefinitionInput) => Promise<boolean>;
  /** Workout library (phase 33), keyed by template id — archived entries included; UI filters. */
  templates: Map<string, WorkoutTemplate>;
  /** Upsert a workout template. Omitted id mints one; the caller resolves title reuse first. */
  saveTemplate: (input: SaveWorkoutTemplateInput) => Promise<{ id: string } | null>;
  /** Soft-remove from the library — score history keys on the id, so never a hard delete. */
  archiveTemplate: (id: string) => Promise<boolean>;
}

export const ScheduleContext = createContext<ScheduleContextValue | null>(null);

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
