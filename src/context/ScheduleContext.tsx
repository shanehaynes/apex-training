import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { parseISO, isSameDay } from 'date-fns';
import scheduleData from '../data/schedule.json';
import { supabase } from '../lib/supabaseClient';
import type { CompletionRow, CompletionLogRow } from '../lib/supabaseClient';
import type { WorkoutEvent, Schedule } from '../types/workout';

const baseSchedule = scheduleData as Schedule;

const LS_KEY = 'apex-completed';

function lsLoad(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function lsSave(ids: Set<string>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...ids])); } catch {}
}

interface ScheduleContextValue {
  events: WorkoutEvent[];
  isSyncing: boolean;
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
  toggleCompletion: (id: string) => void;
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null);

export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  const [completedIds, setCompletedIds] = useState<Set<string>>(lsLoad);
  const [isSyncing, setIsSyncing] = useState(!!supabase);

  // Keep a ref to the current events so toggleCompletion can access metadata
  // without needing to be re-created every time events changes.
  const eventsRef = useRef<WorkoutEvent[]>([]);

  const events = useMemo<WorkoutEvent[]>(
    () => baseSchedule.events.map(e => ({ ...e, isCompleted: completedIds.has(e.id) })),
    [completedIds],
  );
  eventsRef.current = events;

  // On mount: fetch current completion state from Supabase and override localStorage.
  // localStorage stays as an instant cache so the UI renders immediately.
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('workout_completions')
      .select('event_id')
      .eq('is_completed', true)
      .then(({ data, error }) => {
        if (error) {
          console.warn('[apex] Supabase sync failed:', error.message);
        } else {
          const serverIds = new Set((data as Pick<CompletionRow, 'event_id'>[]).map(r => r.event_id));
          setCompletedIds(serverIds);
          lsSave(serverIds);
        }
        setIsSyncing(false);
      });
  }, []);

  const getEventsForDate = useMemo(
    () => (date: Date) => events.filter(e => isSameDay(parseISO(e.date), date)),
    [events],
  );

  const getEventsForRange = useMemo(
    () => (start: Date, end: Date) =>
      events.filter(e => { const d = parseISO(e.date); return d >= start && d <= end; }),
    [events],
  );

  const toggleCompletion = (id: string) => {
    const event = eventsRef.current.find(e => e.id === id);
    if (!event) return;

    // Determine new state before the setter runs (needed for the async call below)
    const isNowCompleted = !completedIds.has(id);

    // Optimistic local update
    setCompletedIds(prev => {
      const next = new Set(prev);
      isNowCompleted ? next.add(id) : next.delete(id);
      lsSave(next);
      return next;
    });

    if (!supabase) return;

    // Upsert current state + append to history log (both fire-and-forget)
    const completionRow: CompletionRow = {
      event_id: id,
      event_date: event.date,
      event_type: event.type,
      event_title: event.title,
      duration_minutes: event.estimatedDuration ?? null,
      is_completed: isNowCompleted,
      completed_at: isNowCompleted ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const logRow: CompletionLogRow = {
      event_id: id,
      event_date: event.date,
      event_type: event.type,
      event_title: event.title,
      duration_minutes: event.estimatedDuration ?? null,
      action: isNowCompleted ? 'complete' : 'uncomplete',
    };

    Promise.all([
      supabase.from('workout_completions').upsert(completionRow),
      supabase.from('workout_completion_log').insert(logRow),
    ]).then(([{ error: upsertErr }, { error: logErr }]) => {
      if (upsertErr) console.warn('[apex] Completion upsert failed:', upsertErr.message);
      if (logErr) console.warn('[apex] Completion log failed:', logErr.message);
    });
  };

  return (
    <ScheduleContext.Provider value={{ events, isSyncing, getEventsForDate, getEventsForRange, toggleCompletion }}>
      {children}
    </ScheduleContext.Provider>
  );
}

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
