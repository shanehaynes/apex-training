import { WORKOUT_COLORS } from '../../utils/workoutColors';
import type { WorkoutEvent, WorkoutType } from '../../types/workout';
import type { SessionListRow } from './sessionsApi';

export function isWorkoutType(type: string | null): type is WorkoutType {
  return !!type && type in WORKOUT_COLORS;
}

/**
 * The occurrence to track. The schedule's expanded list is the first choice
 * (full plan, colours, recurrence); a session whose occurrence is no longer
 * there — a deleted series, a date far outside the expansion — gets a stub
 * carrying what the tracker needs to bootstrap: id, date, title, type.
 */
export function eventForSession(row: SessionListRow, events: readonly WorkoutEvent[]): WorkoutEvent {
  const live = events.find(e => e.id === row.eventId && e.date === row.eventDate);
  if (live) return live;
  return {
    id: row.eventId,
    date: row.eventDate,
    title: row.title,
    type: isWorkoutType(row.type) ? row.type : 'weights',
    exercises: [],
    estimatedDuration: row.durationSeconds ? Math.round(row.durationSeconds / 60) : 0,
    description: '',
    difficulty: 3,
    tags: row.tags,
    isCompleted: !!row.finishedAt,
    isRecurring: false,
  };
}
