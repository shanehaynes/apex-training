export type WorkoutType =
  | 'stretching'
  | 'morning-routine'
  | 'weights'
  | 'climbing'
  | 'cardio'
  | 'yoga'
  | 'rest';

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

export type CalendarView = 'month' | 'week';

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
