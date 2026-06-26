import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, subWeeks, format, parseISO, isWithinInterval } from 'date-fns';
import type { WorkoutEvent, WorkoutType, DateRange, WeekVolume } from '../types/workout';

export function getEventsByDateRange(events: WorkoutEvent[], range: DateRange, referenceDate = new Date()): WorkoutEvent[] {
  if (range === 'all') return events;
  const now = referenceDate;
  const interval = range === 'week'
    ? { start: startOfWeek(now, { weekStartsOn: 0 }), end: endOfWeek(now, { weekStartsOn: 0 }) }
    : { start: startOfMonth(now), end: endOfMonth(now) };
  return events.filter(e => isWithinInterval(parseISO(e.date), interval));
}

export function countByType(events: WorkoutEvent[]): Record<WorkoutType, number> {
  const counts: Record<WorkoutType, number> = {
    stretching: 0, 'morning-routine': 0, weights: 0,
    climbing: 0, cardio: 0, yoga: 0, rest: 0,
  };
  for (const e of events) counts[e.type]++;
  return counts;
}

export function getTotalDuration(events: WorkoutEvent[]): number {
  return events.reduce((sum, e) => sum + e.estimatedDuration, 0);
}

export function getMostActiveDay(events: WorkoutEvent[]): string {
  const dayCounts: Record<string, number> = {};
  for (const e of events) {
    const day = format(parseISO(e.date), 'EEEE');
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }
  const sorted = Object.entries(dayCounts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? '—';
}

export function getUniqueTypes(events: WorkoutEvent[]): number {
  return new Set(events.map(e => e.type)).size;
}

export function getWeeklyVolume(events: WorkoutEvent[], weeksBack = 6): WeekVolume[] {
  const today = new Date();
  return Array.from({ length: weeksBack }, (_, i) => {
    const weekRef = subWeeks(today, weeksBack - 1 - i);
    const start = startOfWeek(weekRef, { weekStartsOn: 0 });
    const end = endOfWeek(weekRef, { weekStartsOn: 0 });
    const weekEvents = events.filter(e => isWithinInterval(parseISO(e.date), { start, end }));
    return {
      weekLabel: format(start, 'MMM d'),
      weekStart: format(start, 'yyyy-MM-dd'),
      count: weekEvents.length,
      totalMinutes: getTotalDuration(weekEvents),
    };
  });
}
