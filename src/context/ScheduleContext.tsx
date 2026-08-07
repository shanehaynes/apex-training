import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { parseISO, isSameDay } from 'date-fns';
import { deleteJson, patchJson, postJson } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import type { CompletionRow, ExerciseDefinitionRow, RecurringExceptionRow, WorkoutEventRow } from '../lib/db/types';
import type { ExerciseDefinition, WorkoutEvent, Schedule } from '../types/workout';
import type { CreateDefinitionInput, CreateEventInput, OccurrenceOverride, UpdateDefinitionInput, UpdateEventInput } from '../lib/schedule/types';
import { expandRecurringEvents, normalizeSeedEvent } from '../lib/schedule/expand';
import { definitionFieldsToRow, resolveEventExercises, rowToDefinition, slugifyName } from '../lib/schedule/definitions';
import { buildCompletionRows, eventFieldsToRow, eventToRow, rowToEvent } from '../lib/schedule/mapping';
import { loadCompletedIds, saveCompletedIds } from '../lib/schedule/localCompletion';
import { useAuth } from './AuthContext';
import { quickCompleteSession, quickUncompleteSession } from '../lib/tracking/sessionRepo';
import { baseIdOf, makeOccurrenceId, occurrenceDateOf } from '../lib/schedule/occurrence';
import { timeToMinutes } from '../lib/time';
import { registerAgentState } from '../dev/agentBridge';
import { isPastDay, now } from '../lib/clock';

// ─── Public types ─────────────────────────────────────────────────────────────

interface ScheduleContextValue {
  events: WorkoutEvent[];
  /** Exercise library, keyed by definition id. Empty offline — entries then render their snapshots. */
  definitions: Map<string, ExerciseDefinition>;
  isSyncing: boolean;
  isEventsLoading: boolean;
  /** Manual refetch — for flows that must not wait on the realtime channel (e.g. template copy). */
  refreshEvents: () => Promise<void>;
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
  toggleCompletion: (id: string) => void;
  /** Idempotent completion set — no-op when already in the desired state. */
  setCompletion: (id: string, completed: boolean) => void;
  createEvent: (input: CreateEventInput) => Promise<{ id: string } | null>;
  updateEvent: (input: UpdateEventInput) => Promise<boolean>;
  deleteEvent: (id: string, triggeredBy?: 'user' | 'ai') => Promise<boolean>;
  deleteEventInstance: (baseId: string, date: string, triggeredBy?: 'user' | 'ai') => Promise<boolean>;
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
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null);

// The 1.3 MB seed file is the offline/error fallback only. import() keeps it
// out of the main bundle so signed-in users never download or parse it.
async function loadSeedEvents(): Promise<WorkoutEvent[]> {
  const seed = (await import('../data/schedule.json')).default as Schedule;
  return (seed.events as WorkoutEvent[]).map(normalizeSeedEvent);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  // Constant for this provider's lifetime: App keys ScheduleProvider by user
  // id, so an account switch remounts rather than re-rendering.
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [baseEvents, setBaseEvents] = useState<WorkoutEvent[]>([]);
  const [definitions, setDefinitions] = useState<Map<string, ExerciseDefinition>>(new Map());
  const [exceptions, setExceptions] = useState<Map<string, OccurrenceOverride | null>>(new Map());
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => loadCompletedIds(userId));
  const [isSyncing, setIsSyncing] = useState(!!supabase);
  const [isEventsLoading, setIsEventsLoading] = useState(!!supabase);

  const eventsRef = useRef<WorkoutEvent[]>([]);
  const baseEventsRef = useRef<WorkoutEvent[]>([]);
  const exceptionsRef = useRef<Map<string, OccurrenceOverride | null>>(new Map());

  // ── Fetch events from Supabase (or fall back to JSON) ──────────────────────

  const loadEvents = useCallback(async () => {
    if (!supabase) {
      setBaseEvents(await loadSeedEvents());
      setIsEventsLoading(false);
      return;
    }

    const [eventsRes, exceptionsRes, definitionsRes] = await Promise.all([
      supabase.from('workout_events').select('*').order('date'),
      // select('*') so rows load (as plain skips) even before the phase7
      // override-columns migration has been applied.
      supabase.from('recurring_exceptions').select('*'),
      supabase.from('exercise_definitions').select('*'),
    ]);

    if (eventsRes.error) {
      console.warn('[apex] Failed to load workout_events:', eventsRes.error.message);
      setBaseEvents(await loadSeedEvents());
    } else {
      setBaseEvents((eventsRes.data as WorkoutEventRow[]).map(rowToEvent));
    }

    // Tolerated failure: entries render their embedded snapshots instead.
    if (!definitionsRes.error && definitionsRes.data) {
      setDefinitions(new Map(
        (definitionsRes.data as ExerciseDefinitionRow[]).map(r => [r.id, rowToDefinition(r)]),
      ));
    }

    if (!exceptionsRes.error && exceptionsRes.data) {
      const exMap = new Map<string, OccurrenceOverride | null>();
      for (const r of exceptionsRes.data as RecurringExceptionRow[]) {
        const hasOverride = r.override_date || r.override_start_time || r.override_end_time;
        exMap.set(
          makeOccurrenceId(r.event_id, r.skipped_date),
          hasOverride
            ? {
                date:      r.override_date ?? undefined,
                startTime: r.override_start_time ?? undefined,
                endTime:   r.override_end_time ?? undefined,
              }
            : null,
        );
      }
      setExceptions(exMap);
    }

    setIsEventsLoading(false);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // ── Realtime: re-fetch whenever events or exceptions change ────────────────

  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const channel = sb
      .channel('schedule-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workout_events' }, loadEvents)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_exceptions' }, loadEvents)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_definitions' }, loadEvents)
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [loadEvents]);

  // ── Completion sync ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('workout_completions')
      .select('event_id')
      .eq('is_completed', true)
      .then(({ data, error }) => {
        if (error) {
          console.warn('[apex] Completion sync failed:', error.message);
        } else {
          const serverIds = new Set((data as Pick<CompletionRow, 'event_id'>[]).map(r => r.event_id));
          setCompletedIds(serverIds);
          saveCompletedIds(userId, serverIds);
        }
        setIsSyncing(false);
      });
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  // Resolve library references on the base rows (before recurrence fan-out,
  // so each series resolves once, not per occurrence).
  const resolvedBase = useMemo(
    () => (definitions.size ? baseEvents.map(e => resolveEventExercises(e, definitions)) : baseEvents),
    [baseEvents, definitions],
  );

  const allExpanded = useMemo(
    () => expandRecurringEvents(resolvedBase, exceptions, now()),
    [resolvedBase, exceptions],
  );

  const events = useMemo<WorkoutEvent[]>(
    () => allExpanded.map(e => ({ ...e, isCompleted: completedIds.has(e.id) })),
    [allExpanded, completedIds],
  );

  // Snapshots for the mutation helpers, written after commit (not during
  // render, which is unsafe under StrictMode/concurrent rendering). Handlers
  // only run after effects, so they always see the current values.
  useEffect(() => {
    eventsRef.current = events;
    baseEventsRef.current = baseEvents;
    exceptionsRef.current = exceptions;
  }, [events, baseEvents, exceptions]);

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('schedule', () => ({
      isSyncing,
      isEventsLoading,
      eventCount: events.length,
      completedCount: completedIds.size,
      definitionIds: [...definitions.keys()],
      events: events.map(e => ({
        id: e.id,
        title: e.title,
        type: e.type,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        isCompleted: e.isCompleted,
        isRecurring: e.isRecurring,
      })),
    }));
  }, [events, definitions, completedIds, isSyncing, isEventsLoading]);

  // ── Queries ────────────────────────────────────────────────────────────────

  const getEventsForDate = useMemo(
    () => (date: Date) =>
      events
        .filter(e => isSameDay(parseISO(e.date), date))
        .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)),
    [events],
  );

  const getEventsForRange = useMemo(
    () => (start: Date, end: Date) =>
      events.filter(e => { const d = parseISO(e.date); return d >= start && d <= end; }),
    [events],
  );

  // ── Completion toggle ──────────────────────────────────────────────────────

  const applyCompletion = (id: string, isNowCompleted: boolean) => {
    const event = eventsRef.current.find(e => e.id === id);
    if (!event) return;

    setCompletedIds(prev => {
      const next = new Set(prev);
      if (isNowCompleted) next.add(id);
      else next.delete(id);
      saveCompletedIds(userId, next);
      return next;
    });

    if (!supabase) return;

    postJson('/api/completions', buildCompletionRows(event, isNowCompleted), 'Completion sync').catch(() => {});
  };

  // The explicit "Mark as Complete" toggle also logs (or un-logs) the whole
  // plan at its recommended targets. The tracker's Finish path goes through
  // setCompletion instead — it has real actuals and must not be plan-filled.
  const toggleCompletion = (id: string) => {
    const isNowCompleted = !completedIds.has(id);
    const event = eventsRef.current.find(e => e.id === id);
    applyCompletion(id, isNowCompleted);
    if (!event) return;
    if (isNowCompleted) quickCompleteSession(event).catch(() => {});
    else quickUncompleteSession(event.id, event.date).catch(() => {});
  };

  const setCompletion = (id: string, completed: boolean) => {
    if (completedIds.has(id) === completed) return;
    applyCompletion(id, completed);
  };

  // ── Mutation helpers ───────────────────────────────────────────────────────

  const createEvent = useCallback(async (input: CreateEventInput): Promise<{ id: string } | null> => {
    if (!supabase) return null;

    // UUID, not a timestamp: workout_events.id is a global PK across users,
    // so two people composing at the same millisecond must never collide.
    const id = `ai-${crypto.randomUUID()}`;
    // An event added to a day that has already passed is a retro-log: it was
    // done, not planned, so it completes on creation (same effect as the
    // "Mark as Complete" toggle, including the plan-filled session log).
    const completedOnCreate = isPastDay(input.date);
    const newEvent: WorkoutEvent = {
      id,
      type:              input.type,
      title:             input.title,
      date:              input.date,
      estimatedDuration: input.estimatedDuration,
      difficulty:        input.difficulty ?? 3,
      startTime:         input.startTime,
      endTime:           input.endTime,
      description:       input.description ?? '',
      location:          input.location,
      tags:              input.tags ?? [],
      equipment:         input.equipment ?? [],
      exercises:         input.exercises ?? [],
      warmup:            input.warmup,
      cooldown:          input.cooldown,
      cardioTargets:     input.cardioTargets,
      climbingTargets:   input.climbingTargets,
      isCompleted:       completedOnCreate,
      isRecurring:       false,
    };

    try {
      await postJson('/api/events', { ...eventToRow(newEvent), triggered_by: input.triggeredBy ?? 'user' }, 'Creating event');
      if (completedOnCreate) {
        setCompletedIds(prev => {
          const next = new Set(prev).add(id);
          saveCompletedIds(userId, next);
          return next;
        });
        postJson('/api/completions', buildCompletionRows(newEvent, true), 'Completion sync').catch(() => {});
        quickCompleteSession(newEvent).catch(() => {});
      }
      return { id };
    } catch {
      return null;
    }
  }, [userId]);

  const updateEvent = useCallback(async ({ id, fields, triggeredBy }: UpdateEventInput): Promise<boolean> => {
    if (!supabase) return false;

    const current = eventsRef.current.find(e => e.id === id);
    const baseId = baseIdOf(id);

    try {
      await patchJson(`/api/events?id=${encodeURIComponent(baseId)}`, {
        fields: eventFieldsToRow(fields),
        log: {
          event_title: fields.title ?? current?.title ?? baseId,
          event_date:  fields.date ?? current?.date,
          diff:        { before: current ?? {}, after: fields },
          triggered_by: triggeredBy ?? 'user',
        },
      }, 'Updating event');
      // Apply locally on success — the realtime refetch reconciles later, but
      // the UI (e.g. the modal after an exercise edit) must not wait for it.
      setBaseEvents(prev => prev.map(e => e.id !== baseId ? e : { ...e, ...fields }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const deleteEvent = useCallback(async (id: string, triggeredBy: 'user' | 'ai' = 'user'): Promise<boolean> => {
    if (!supabase) return false;

    const event = eventsRef.current.find(e => e.id === id);
    const baseId = baseIdOf(id);

    try {
      await deleteJson(`/api/events?id=${encodeURIComponent(baseId)}`, 'Deleting event', {
        log: { event_title: event?.title ?? baseId, event_date: event?.date, triggered_by: triggeredBy },
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  const rescheduleEvent = useCallback(async (id: string, fields: OccurrenceOverride, triggeredBy: 'user' | 'ai' = 'user'): Promise<boolean> => {
    if (!supabase) return false;
    if (fields.date === undefined && fields.startTime === undefined && fields.endTime === undefined) return true;

    const event = eventsRef.current.find(e => e.id === id);
    if (!event) return false;

    if (!event.isRecurring) {
      const ok = await updateEvent({ id, fields, triggeredBy });
      // Apply locally on success — the realtime refetch reconciles later, but
      // the UI must not depend on it arriving.
      if (ok) {
        setBaseEvents(prev => prev.map(e => e.id !== id ? e : {
          ...e,
          date:      fields.date ?? e.date,
          startTime: fields.startTime ?? e.startTime,
          endTime:   fields.endTime ?? e.endTime,
        }));
      }
      return ok;
    }

    // A recurring occurrence: write a per-occurrence override keyed at the
    // occurrence's original generated date (the base anchor date for the base
    // row itself), merged over any earlier override so repeated edits stack.
    const baseId = baseIdOf(id);
    const keyDate = occurrenceDateOf(id)
      ?? baseEventsRef.current.find(e => e.id === baseId)?.date
      ?? event.date;
    const key = makeOccurrenceId(baseId, keyDate);
    const merged = { ...exceptionsRef.current.get(key), ...fields };

    try {
      await postJson('/api/event-instances', {
        eventId: baseId,
        date: keyDate,
        eventTitle: event.title,
        triggeredBy,
        overrides: merged,
      }, 'Rescheduling occurrence');
      setExceptions(prev => new Map(prev).set(key, merged));
      return true;
    } catch {
      return false;
    }
  }, [updateEvent]);

  const createDefinition = useCallback(async (input: CreateDefinitionInput): Promise<{ id: string } | null> => {
    if (!supabase) return null;

    // triggeredBy is request metadata, not a definition field — keep it out
    // of the optimistic map and the row payload.
    const { triggeredBy, ...fields } = input;
    const def = {
      id: fields.id ?? slugifyName(fields.canonicalName),
      aliases: [], muscleGroups: [], equipment: [], isUnilateral: false,
      ...fields,
    };
    try {
      await postJson('/api/exercise-definitions', {
        id: def.id,
        ...definitionFieldsToRow(def),
        triggered_by: triggeredBy ?? 'user',
      }, 'Creating exercise');
      // Optimistic: entries referencing the new definition resolve immediately;
      // the realtime refetch reconciles later.
      setDefinitions(prev => new Map(prev).set(def.id, def));
      return { id: def.id };
    } catch {
      return null;
    }
  }, []);

  const updateDefinition = useCallback(async ({ id, fields, triggeredBy }: UpdateDefinitionInput): Promise<boolean> => {
    if (!supabase) return false;

    const current = definitions.get(id);
    try {
      await patchJson(`/api/exercise-definitions?id=${encodeURIComponent(id)}`, {
        fields: definitionFieldsToRow(fields),
        log: {
          definition_name: fields.canonicalName ?? current?.canonicalName ?? id,
          diff: { before: current ?? {}, after: fields },
          triggered_by: triggeredBy ?? 'user',
        },
      }, 'Updating exercise');
      return true;
    } catch {
      return false;
    }
  }, [definitions]);

  const deleteEventInstance = useCallback(async (baseId: string, date: string, triggeredBy: 'user' | 'ai' = 'user'): Promise<boolean> => {
    if (!supabase) return false;

    const event = eventsRef.current.find(e => e.id === baseId || e.id.startsWith(baseId));
    try {
      await postJson('/api/event-instances', { eventId: baseId, date, eventTitle: event?.title ?? baseId, triggeredBy }, 'Deleting instance');
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <ScheduleContext.Provider value={{
      events,
      definitions,
      isSyncing,
      isEventsLoading,
      refreshEvents: loadEvents,
      getEventsForDate,
      getEventsForRange,
      toggleCompletion,
      setCompletion,
      createEvent,
      updateEvent,
      deleteEvent,
      deleteEventInstance,
      rescheduleEvent,
      createDefinition,
      updateDefinition,
    }}>
      {children}
    </ScheduleContext.Provider>
  );
}

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
