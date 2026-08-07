import type { ExerciseDefinition, WorkoutEvent, WorkoutType } from '../../types/workout';

// Inputs for schedule mutations — shared by ScheduleContext (which
// implements them) and the coach tool registry (which invokes them).

export interface CreateEventInput {
  type: WorkoutType;
  title: string;
  date: string;
  estimatedDuration: number;
  /** Audit-log attribution; ScheduleContext defaults to 'user', the coach executor passes 'ai'. */
  triggeredBy?: 'user' | 'ai';
  difficulty?: 1 | 2 | 3 | 4 | 5;
  startTime?: string;
  endTime?: string;
  description?: string;
  location?: string;
  tags?: string[];
  equipment?: string[];
  exercises?: WorkoutEvent['exercises'];
  warmup?: WorkoutEvent['warmup'];
  cooldown?: WorkoutEvent['cooldown'];
  cardioTargets?: WorkoutEvent['cardioTargets'];
  climbingTargets?: WorkoutEvent['climbingTargets'];
}

export interface UpdateEventInput {
  id: string;
  fields: Partial<Omit<WorkoutEvent, 'id' | 'isCompleted'>>;
  /** Audit-log attribution; ScheduleContext defaults to 'user', the coach executor passes 'ai'. */
  triggeredBy?: 'user' | 'ai';
}

/** A new exercise library entry. id defaults to a slug of canonicalName. */
export type CreateDefinitionInput =
  Pick<ExerciseDefinition, 'canonicalName' | 'category'> &
  Partial<Omit<ExerciseDefinition, 'canonicalName' | 'category'>> &
  { triggeredBy?: 'user' | 'ai' };

export interface UpdateDefinitionInput {
  id: string;
  /** archivedAt: explicit null clears archived_at server-side (undefined is dropped by the field mapper). */
  fields: Partial<Omit<ExerciseDefinition, 'id' | 'archivedAt'>> & { archivedAt?: string | null };
  /** Audit-log attribution; ScheduleContext defaults to 'user', the coach executor passes 'ai'. */
  triggeredBy?: 'user' | 'ai';
}

/**
 * Date/time override for a single occurrence of a recurring series. Only the
 * fields present are overridden; the rest fall back to the base event.
 */
export interface OccurrenceOverride {
  date?: string;
  startTime?: string;
  endTime?: string;
}
