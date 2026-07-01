export type WorkoutType =
  | 'stretching'
  | 'morning-routine'
  | 'weights'
  | 'climbing'
  | 'cardio'
  | 'yoga';

export interface Exercise {
  id: string;
  name: string;
  category: 'strength' | 'stretch' | 'cardio' | 'skill' | 'mobility';
  sets?: number;
  reps?: string;
  duration?: string;
  weight?: string;
  restPeriod?: string;
  notes?: string;
  imageUrl?: string;
  muscleGroups?: string[];
}

export interface WorkoutEvent {
  id: string;
  type: WorkoutType;
  title: string;
  subtitle?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  estimatedDuration: number;
  description: string;
  warmup?: Exercise[];
  exercises: Exercise[];
  cooldown?: Exercise[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  location?: string;
  coverImageUrl?: string;
  tags: string[];
  equipment?: string[];
  isCompleted: boolean;
  completedAt?: string;
  isRecurring: boolean;
  /**
   * Canonical RFC 5545 RRULE value string (no 'RRULE:' prefix), e.g.
   * 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231'. Parsed and expanded by
   * src/lib/recurrence/. Source of truth for the recurrence pattern.
   */
  recurrenceRule?: string;
  /** @deprecated Superseded by recurrenceRule — kept for legacy row display only. */
  recurringPattern?: {
    frequency: 'daily' | 'weekly' | 'custom';
    daysOfWeek?: number[];
    endDate?: string;
  };
}

export interface Schedule {
  version: string;
  lastUpdated: string;
  events: WorkoutEvent[];
}

export type DateRange = 'week' | 'month' | 'all';

export type CalendarView = 'month' | 'week' | 'day';

export interface WeekVolume {
  weekLabel: string;
  weekStart: string;
  count: number;
  totalMinutes: number;
}

export interface WorkoutColorConfig {
  solid: string;
  light: string;
  glow: string;
  border: string;
  label: string;
}
