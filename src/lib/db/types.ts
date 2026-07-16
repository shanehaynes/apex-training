// Row shapes for the Supabase tables (snake_case DB columns) — the single
// authoritative definition, shared by the browser client (src/) and the
// Vercel serverless functions (api/, via type-only imports).
//
// user_id (phase 9) is optional on every row type: the client never sends
// it (the /api/* handlers stamp it from the verified JWT) and never needs
// to read it (RLS already scopes selects to the signed-in user).

export type AvatarKey =
  | 'goat' | 'ibex' | 'snow-leopard' | 'eagle' | 'wolf'
  | 'bighorn' | 'marmot' | 'raven' | 'lynx' | 'fox'
  | 'bear' | 'owl' | 'falcon' | 'pika' | 'elk'
  | 'wolverine' | 'cougar' | 'chamois' | 'yak' | 'hare'
  | 'orca' | 'seal' | 'otter' | 'octopus';

// One row per auth user (phase 9). Client-writable fields go through
// /api/profile; the rest are server-managed.
export interface ProfileRow {
  id: string;
  display_name: string;
  avatar_key: AvatarKey;
  is_template_source: boolean;
  template_copied_at: string | null;
  ics_token: string;
  created_at: string;
  updated_at: string;
}

export interface CompletionRow {
  user_id?: string;
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
  user_id?: string;
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  action: 'complete' | 'uncomplete';
}

// Row shape returned by Supabase for workout_events (snake_case DB columns).
export interface WorkoutEventRow {
  user_id?: string;
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
  /** Planned cardio targets jsonb (camelCase payload, like the exercise columns); optional so pre-migration rows still type-check. */
  cardio_targets?: unknown;
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
  user_id?: string;
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
  user_id?: string;
  event_id: string;
  event_date: string;
  section: TrackedSection;
  exercise_id: string;
  exercise_name: string;
  /** Stamped on rows logged after phase 8; older rows are matched by name+alias. */
  definition_id?: string | null;
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
  user_id?: string;
  event_id: string;
  event_date: string;
  section: TrackedSection;
  exercise_id: string;
  exercise_name: string;
  /** Stamped on rows logged after phase 8; older rows are matched by name+alias. */
  definition_id?: string | null;
  duration_minutes: number | null;
  distance: string | null;
  elevation_gain: string | null;
  avg_heart_rate: number | null;
  is_autofilled: boolean;
}

// All overrides NULL = the occurrence at skipped_date is removed. Any
// override set = that occurrence is displayed at override_date (or
// skipped_date when only the time changed) with the overridden times.
export interface RecurringExceptionRow {
  user_id?: string;
  id: string;
  event_id: string;
  skipped_date: string;
  override_date: string | null;
  override_start_time: string | null;
  override_end_time: string | null;
  created_at: string;
}

export interface EventMutationLogRow {
  operation: 'create' | 'update' | 'delete' | 'delete_instance' | 'update_instance';
  event_id: string;
  event_title: string;
  event_date?: string;
  diff?: Record<string, unknown>;
  triggered_by?: string;
}

// One row per movement in the exercise library (phase 8) — identity and
// descriptive metadata shared by every referencing event entry.
export interface ExerciseDefinitionRow {
  user_id?: string;
  id: string;
  canonical_name: string;
  aliases: string[];
  category: string;
  muscle_groups: string[];
  equipment: string[];
  image_url: string | null;
  technique_notes: string | null;
  is_unilateral: boolean;
  default_sets: number | null;
  default_reps: string | null;
  default_duration: string | null;
  default_weight: string | null;
  default_rest: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// One row per user per review period (phase 12). Server-only: RLS with no
// policies, written and read exclusively by the review cron. `stats` holds
// the pre-computed ReviewStats / YearlyStats JSON (src/lib/review/types.ts).
export interface ReviewRow {
  user_id?: string;
  id: string;
  period_type: 'month' | 'year';
  iso_year: number;
  /** 1–13 for month rows, null for year rows. */
  month_index: number | null;
  stats: unknown;
  ai_commentary: string | null;
  email_sent_at: string | null;
  email_skipped_reason: 'no-activity' | 'no-email' | null;
  created_at: string;
  updated_at: string;
}

export interface DefinitionMutationLogRow {
  operation: 'create' | 'update' | 'archive' | 'unarchive' | 'delete';
  definition_id: string;
  definition_name: string;
  diff?: Record<string, unknown>;
  triggered_by?: string;
}
