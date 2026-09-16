import { createContext, useContext } from 'react';
import type { ExerciseDefinition, WorkoutEvent, WorkoutTemplate } from '../types/workout';
import type { CreateDefinitionInput, OccurrenceOverride, UpdateDefinitionInput, UpdateEventInput } from '../lib/schedule/types';
import type { WorkoutDraft } from '../lib/builder/draft';

// Context object + hook live apart from the provider so ScheduleContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

// ─── The /api/workout-draft wire ──────────────────────────────────────────────
// Mirrors api/_lib/services/workoutDraft.ts, declared here rather than
// imported: nothing under src/ imports from api/ (the BootstrapWire
// precedent, src/lib/tracking/sessionRepo.ts). api/__tests__/workout-draft.
// test.ts pins the server side of this shape.

/**
 * Which write the draft asks for. `occurrenceDate` is deliberately absent —
 * the provider resolves the occurrence's keying date, which only it can (see
 * applyWorkoutDraft).
 */
export type WorkoutDraftRequest =
  | { kind: 'create' }
  | { kind: 'update'; eventId: string }
  | { kind: 'detach'; eventId: string };

/**
 * The 200 body. `ok: false` is the builder's own validation, answered on 200
 * (never a 4xx) so the client keeps the text and the per-entry map;
 * `violations` is keyed by draft entry id.
 */
export type WorkoutDraftResult =
  | { ok: false; problem: string; violations?: Record<string, string> }
  | {
      ok: true;
      action: WorkoutDraftRequest['kind'];
      /** The event written: the new row's id for create/detach, the base id for update. */
      id: string;
      templateId?: string;
      date: string;
      completedOnCreate: boolean;
      isRecurring: boolean;
      /** detach only: the series the occurrence left, and the date it was keyed on. */
      detachedFrom?: string;
      occurrenceDate?: string;
      /** The event as `/api/schedule` would serve its base — placed without a refetch. */
      event: WorkoutEvent;
    };

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
  /**
   * The builder's Apply and Save changes, in one POST /api/workout-draft: the
   * server validates the draft, resolves template identity, upserts the
   * template and then creates / PATCHes / detaches — running the same pure
   * functions this client would have. The response is placed locally, so the
   * calendar never waits on the realtime refetch.
   *
   * Returns null when the request itself failed (the transport has already
   * toasted); `{ ok: false }` is the draft's own validation, and the caller
   * renders `problem` / `violations` itself.
   */
  applyWorkoutDraft: (draft: WorkoutDraft, request: WorkoutDraftRequest) => Promise<WorkoutDraftResult | null>;
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
  /** Add a movement to the exercise library. */
  createDefinition: (input: CreateDefinitionInput) => Promise<{ id: string } | null>;
  /** Edit library-tier fields; a canonicalName change auto-appends the old name as an alias server-side. */
  updateDefinition: (input: UpdateDefinitionInput) => Promise<boolean>;
  /** Workout library (phase 33), keyed by template id — archived entries included; UI filters. */
  templates: Map<string, WorkoutTemplate>;
  /** Soft-remove from the library — score history keys on the id, so never a hard delete. */
  archiveTemplate: (id: string) => Promise<boolean>;
}

export const ScheduleContext = createContext<ScheduleContextValue | null>(null);

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
