// Row shapes for the Supabase tables (snake_case DB columns) — the single
// authoritative definition, shared by the browser client (src/) and the
// Vercel serverless functions (api/, via type-only imports).

export interface CompletionRow {
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  is_completed: boolean;
  completed_at: string | null;
  updated_at: string;
}

export interface CompletionLogRow {
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  action: 'complete' | 'uncomplete';
}

// Row shape returned by Supabase for workout_events (snake_case DB columns).
export interface WorkoutEventRow {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  estimated_duration: number;
  description: string;
  warmup: unknown[];
  exercises: unknown[];
  cooldown: unknown[];
  difficulty: number;
  location: string | null;
  cover_image_url: string | null;
  tags: string[];
  equipment: string[];
  is_recurring: boolean;
  /** Canonical RFC 5545 RRULE value (no 'RRULE:' prefix) — see src/lib/recurrence/. */
  recurrence_rule: string | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_frequency: string | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_days: number[] | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_end_date: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Phase 4: workout tracking rows ──────────────────────────────────────────
// event_id follows the workout_completions convention: for recurring
// occurrences it is the expanded `${baseId}__${date}` id.

export interface WorkoutSessionRow {
  id: string;
  event_id: string;
  event_date: string;
  started_at: string;
  finished_at: string | null;
  total_duration_seconds: number | null;
  /** AI-generated post-workout summary, saved once at Finish. */
  coach_summary: string | null;
  updated_at: string;
}

export type TrackedSection = 'warmup' | 'exercise' | 'cooldown';

export interface SetLogRow {
  event_id: string;
  event_date: string;
  section: TrackedSection;
  exercise_id: string;
  exercise_name: string;
  set_number: number;
  planned_weight: string | null;
  planned_reps: string | null;
  planned_duration: string | null;
  actual_weight: string | null;
  actual_reps: string | null;
  actual_duration: string | null;
  is_autofilled: boolean;
}

export interface CardioLogRow {
  event_id: string;
  event_date: string;
  section: TrackedSection;
  exercise_id: string;
  exercise_name: string;
  duration_minutes: number | null;
  distance: string | null;
  elevation_gain: string | null;
  avg_heart_rate: number | null;
}

export interface RecurringExceptionRow {
  id: string;
  event_id: string;
  skipped_date: string;
  created_at: string;
}

export interface EventMutationLogRow {
  operation: 'create' | 'update' | 'delete' | 'delete_instance';
  event_id: string;
  event_title: string;
  event_date?: string;
  diff?: Record<string, unknown>;
  triggered_by?: string;
}
