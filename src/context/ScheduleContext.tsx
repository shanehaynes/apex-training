import { createContext, useContext, useMemo } from 'react';
import { parseISO, isSameDay } from 'date-fns';
import scheduleData from '../data/schedule.json';
import type { WorkoutEvent, Schedule } from '../types/workout';

const schedule = scheduleData as Schedule;

interface ScheduleContextValue {
  events: WorkoutEvent[];
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null);

export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  const events = useMemo(() => schedule.events, []);

  const getEventsForDate = useMemo(() => (date: Date) =>
    events.filter(e => isSameDay(parseISO(e.date), date)),
  [events]);

  const getEventsForRange = useMemo(() => (start: Date, end: Date) =>
    events.filter(e => {
      const d = parseISO(e.date);
      return d >= start && d <= end;
    }),
  [events]);

  return (
    <ScheduleContext.Provider value={{ events, getEventsForDate, getEventsForRange }}>
      {children}
    </ScheduleContext.Provider>
  );
}

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
