import type { WorkoutEvent, WorkoutType } from '../../types/workout';

// Inputs for schedule mutations — shared by ScheduleContext (which
// implements them) and the coach tool registry (which invokes them).

export interface CreateEventInput {
  type: WorkoutType;
  title: string;
  date: string;
  estimatedDuration: number;
  difficulty?: 1 | 2 | 3 | 4 | 5;
  startTime?: string;
  endTime?: string;
  description?: string;
  location?: string;
  tags?: string[];
  equipment?: string[];
  exercises?: WorkoutEvent['exercises'];
}

export interface UpdateEventInput {
  id: string;
  fields: Partial<Omit<WorkoutEvent, 'id' | 'isCompleted'>>;
}
