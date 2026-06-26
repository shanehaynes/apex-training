import { createContext, useContext, useMemo, useState } from 'react';
import { parseISO, isSameDay } from 'date-fns';
import scheduleData from '../data/schedule.json';
import type { WorkoutEvent, Schedule } from '../types/workout';

const baseSchedule = scheduleData as Schedule;

interface ScheduleContextValue {
  events: WorkoutEvent[];
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
  toggleCompletion: (id: string) => void;
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null);

function loadCompletedIds(): Set<string> {
  try {
    const raw = localStorage.getItem('apex-completed');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  const [completedIds, setCompletedIds] = useState<Set<string>>(loadCompletedIds);

  const events = useMemo<WorkoutEvent[]>(
    () => baseSchedule.events.map(e => ({ ...e, isCompleted: completedIds.has(e.id) })),
    [completedIds],
  );

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
    setCompletedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('apex-completed', JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  return (
    <ScheduleContext.Provider value={{ events, getEventsForDate, getEventsForRange, toggleCompletion }}>
      {children}
    </ScheduleContext.Provider>
  );
}

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
