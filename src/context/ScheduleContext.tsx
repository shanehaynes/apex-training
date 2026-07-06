import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { parseISO, isSameDay } from 'date-fns';
import scheduleData from '../data/schedule.json';
import { deleteJson, patchJson, postJson } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import type { CompletionRow, RecurringExceptionRow, WorkoutEventRow } from '../lib/db/types';
import type { WorkoutEvent, Schedule } from '../types/workout';
import type { CreateEventInput, OccurrenceOverride, UpdateEventInput } from '../lib/schedule/types';
import { expandRecurringEvents, normalizeSeedEvent } from '../lib/schedule/expand';
import { buildCompletionRows, eventFieldsToRow, eventToRow, rowToEvent } from '../lib/schedule/mapping';
import { loadCompletedIds, saveCompletedIds } from '../lib/schedule/localCompletion';
import { quickCompleteSession, quickUncompleteSession } from '../lib/tracking/sessionRepo';
import { baseIdOf, makeOccurrenceId, occurrenceDateOf } from '../lib/schedule/occurrence';
import { timeToMinutes } from '../lib/time';

// ─── Public types ─────────────────────────────────────────────────────────────

interface ScheduleContextValue {
  events: WorkoutEvent[];
  isSyncing: boolean;
  isEventsLoading: boolean;
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
  toggleCompletion: (id: string) => void;
  /** Idempotent completion set — no-op when already in the desired state. */
  setCompletion: (id: string, completed: boolean) => void;
  createEvent: (input: CreateEventInput) => Promise<{ id: string } | null>;
  updateEvent: (input: UpdateEventInput) => Promise<boolean>;
  deleteEvent: (id: string) => Promise<boolean>;
  deleteEventInstance: (baseId: string, date: string) => Promise<boolean>;
  /**
   * Move a single event to a new date and/or time. One-off events are patched
   * directly; a recurring occurrence gets a per-occurrence override so the
   * rest of the series is untouched.
   */
  rescheduleEvent: (id: string, fields: OccurrenceOverride) => Promise<boolean>;
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  const [baseEvents, setBaseEvents] = useState<WorkoutEvent[]>([]);
  const [exceptions, setExceptions] = useState<Map<string, OccurrenceOverride | null>>(new Map());
  const [completedIds, setCompletedIds] = useState<Set<string>>(loadCompletedIds);
  const [isSyncing, setIsSyncing] = useState(!!supabase);
  const [isEventsLoading, setIsEventsLoading] = useState(!!supabase);

  const eventsRef = useRef<WorkoutEvent[]>([]);
  const baseEventsRef = useRef<WorkoutEvent[]>([]);
  const exceptionsRef = useRef<Map<string, OccurrenceOverride | null>>(new Map());

  // ── Fetch events from Supabase (or fall back to JSON) ──────────────────────

  const loadEvents = useCallback(async () => {
    if (!supabase) {
      setBaseEvents(((scheduleData as Schedule).events as WorkoutEvent[]).map(normalizeSeedEvent));
      setIsEventsLoading(false);
      return;
    }

    const [eventsRes, exceptionsRes] = await Promise.all([
      supabase.from('workout_events').select('*').order('date'),
      // select('*') so rows load (as plain skips) even before the phase7
      // override-columns migration has been applied.
      supabase.from('recurring_exceptions').select('*'),
    ]);

    if (eventsRes.error) {
      console.warn('[apex] Failed to load workout_events:', eventsRes.error.message);
      setBaseEvents(((scheduleData as Schedule).events as WorkoutEvent[]).map(normalizeSeedEvent));
    } else {
      setBaseEvents((eventsRes.data as WorkoutEventRow[]).map(rowToEvent));
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
          saveCompletedIds(serverIds);
        }
        setIsSyncing(false);
      });
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const allExpanded = useMemo(
    () => expandRecurringEvents(baseEvents, exceptions),
    [baseEvents, exceptions],
  );

  const events = useMemo<WorkoutEvent[]>(
    () => allExpanded.map(e => ({ ...e, isCompleted: completedIds.has(e.id) })),
    [allExpanded, completedIds],
  );
  eventsRef.current = events;
  baseEventsRef.current = baseEvents;
  exceptionsRef.current = exceptions;

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
      saveCompletedIds(next);
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

    const id = `ai-${Date.now()}`;
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
      isCompleted:       false,
      isRecurring:       false,
    };

    try {
      await postJson('/api/events', eventToRow(newEvent), 'Creating event');
      return { id };
    } catch {
      return null;
    }
  }, []);

  const updateEvent = useCallback(async ({ id, fields }: UpdateEventInput): Promise<boolean> => {
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
        },
      }, 'Updating event');
      return true;
    } catch {
      return false;
    }
  }, []);

  const deleteEvent = useCallback(async (id: string): Promise<boolean> => {
    if (!supabase) return false;

    const event = eventsRef.current.find(e => e.id === id);
    const baseId = baseIdOf(id);

    try {
      await deleteJson(`/api/events?id=${encodeURIComponent(baseId)}`, 'Deleting event', {
        log: { event_title: event?.title ?? baseId, event_date: event?.date },
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  const rescheduleEvent = useCallback(async (id: string, fields: OccurrenceOverride): Promise<boolean> => {
    if (!supabase) return false;
    if (fields.date === undefined && fields.startTime === undefined && fields.endTime === undefined) return true;

    const event = eventsRef.current.find(e => e.id === id);
    if (!event) return false;

    if (!event.isRecurring) {
      return updateEvent({ id, fields });
    }

    // A recurring occurrence: write a per-occurrence override keyed at the
    // occurrence's original generated date (the base anchor date for the base
    // row itself), merged over any earlier override so repeated edits stack.
    const baseId = baseIdOf(id);
    const keyDate = occurrenceDateOf(id)
      ?? baseEventsRef.current.find(e => e.id === baseId)?.date
      ?? event.date;
    const existing = exceptionsRef.current.get(makeOccurrenceId(baseId, keyDate));

    try {
      await postJson('/api/event-instances', {
        eventId: baseId,
        date: keyDate,
        eventTitle: event.title,
        overrides: { ...existing, ...fields },
      }, 'Rescheduling occurrence');
      return true;
    } catch {
      return false;
    }
  }, [updateEvent]);

  const deleteEventInstance = useCallback(async (baseId: string, date: string): Promise<boolean> => {
    if (!supabase) return false;

    const event = eventsRef.current.find(e => e.id === baseId || e.id.startsWith(baseId));
    try {
      await postJson('/api/event-instances', { eventId: baseId, date, eventTitle: event?.title ?? baseId }, 'Deleting instance');
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <ScheduleContext.Provider value={{
      events,
      isSyncing,
      isEventsLoading,
      getEventsForDate,
      getEventsForRange,
      toggleCompletion,
      setCompletion,
      createEvent,
      updateEvent,
      deleteEvent,
      deleteEventInstance,
      rescheduleEvent,
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
