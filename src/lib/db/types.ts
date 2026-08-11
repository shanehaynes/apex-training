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
  /** Athletic goal for the AI coach ('' = not set). */
  coach_goal: string;
  /** Free-form athlete context for the AI coach ('' = not set). */
  coach_context: string;
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
  /** Planned outdoor-climbing targets jsonb; optional so pre-migration rows still type-check. */
  climbing_targets?: unknown;
  /** Canonical RFC 5545 RRULE value (no 'RRULE:' prefix) — see src/lib/recurrence/. */
  recurrence_rule: string | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_frequency: string | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_days: number[] | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_end_date: string | null;
  /** Provider provenance ('coros'); optional so pre-phase27 rows still type-check. Never set on recurring base rows. */
  source?: string | null;
  created_at: string;
  updated_at: string;
}

// Row shape returned by Supabase for meals (phase 22). Numeric macro columns
// are nullable — blank form fields stay unset rather than becoming zeros.
export interface MealRow {
  user_id?: string;
  id: string;
  title: string;
  date: string;
  time: string | null;
  meal_type: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  fat_total_g: number | null;
  fat_saturated_g: number | null;
  fat_trans_g: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

// Row shape for meal_favorites (phase 24): a meals row minus date/time.
export interface MealFavoriteRow {
  user_id?: string;
  id: string;
  title: string;
  meal_type: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  fat_total_g: number | null;
  fat_saturated_g: number | null;
  fat_trans_g: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface MealMutationLogRow {
  operation: 'create' | 'update' | 'delete';
  meal_id: string;
  meal_title: string;
  diff?: Record<string, unknown>;
  triggered_by?: string;
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

// ─── Phase 19: objectives & training blocks ──────────────────────────────────
// The semantic layer: an objective is what the training is aimed at, a block
// is a dated stretch of training aimed at it. Block membership for a workout
// is derived from event_date (blocks may not overlap), so no block_id column
// exists on workout_events — see the phase19 migration for why.

export interface ObjectiveRow {
  user_id?: string;
  id: string;
  name: string;
  /** null = undated aspiration. */
  target_date: string | null;
  discipline: 'alpine' | 'ice' | 'rock' | 'ski' | 'general' | null;
  notes: string;
  /** Phase 2: [{ metric, target, unit }] scored against benchmarks. Empty until then. */
  required_capabilities: unknown[];
  status: 'active' | 'achieved' | 'abandoned';
  created_at: string;
  updated_at: string;
}

export interface TrainingBlockRow {
  user_id?: string;
  id: string;
  objective_id: string | null;
  name: string;
  intent: string;
  phase: 'base' | 'build' | 'peak' | 'taper' | 'recovery' | 'maintenance' | null;
  /** Half-open [start_date, end_date_exclusive), both Mondays — matches Period. */
  start_date: string;
  end_date_exclusive: string;
  /** WeeklyTargets jsonb (camelCase payload, like cardio_targets). */
  weekly_targets: unknown;
  created_at: string;
  updated_at: string;
}

export interface BlockMutationLogRow {
  operation: 'create' | 'update' | 'delete';
  resource: 'block' | 'objective';
  resource_id: string;
  resource_name: string;
  diff?: Record<string, unknown>;
  triggered_by?: string;
}

// ─── Provider sync (phase 27) ────────────────────────────────────────────────
// COROS today; provider strings widen for Garmin/Apple later.

export type SyncProvider = 'coros';

/** Service-role only (RLS with no policies) — the browser never sees this row,
 *  only the status/timestamp projection returned by /api/provider-sync. */
export interface ProviderConnectionRow {
  user_id: string;
  provider: SyncProvider;
  /** keyCrypto-encrypted (enc:v1:…); null while OAuth is pending. */
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  status: 'pending' | 'connected' | 'expired';
  /** { state, codeVerifier (encrypted), createdAt } during the redirect dance. */
  pending_oauth: Record<string, unknown> | null;
  /** The recorded activity-grab watermark; the imports ledger is what dedupes. */
  last_synced_at: string | null;
  connected_at: string | null;
  updated_at: string;
}

/** Service-role only. One row per provider activity ever imported. */
export interface ProviderActivityImportRow {
  user_id: string;
  provider: SyncProvider;
  activity_id: string;
  mode: 'created' | 'filled';
  /** Occurrence id when filled; the coros-<activityId> event id when created. */
  event_id: string;
  event_date: string;
  imported_at: string;
}

/** Measured metrics kept out of the calendar read path. Anon SELECT allowed
 *  (per-user policy) so the event detail view can read summaries directly. */
export interface ActivityStreamsRow {
  user_id?: string;
  event_id: string;
  event_date: string;
  provider: SyncProvider;
  activity_id: string;
  /** Scalars: sport, avgHr, maxHr, hrZones, calories, hrv, trainingLoad, vo2max, fileUrls… */
  summary: Record<string, unknown>;
  /** Series, downsampled to ≤ ~2000 points each: { hr: [[sec,bpm]…], gps: [[sec,lat,lon,ele]…] }. */
  streams: Record<string, unknown> | null;
  created_at: string;
}
