// Row shapes for the Supabase tables (snake_case DB columns) — shared by the
// browser client (src/) and the Vercel serverless functions (api/, via
// type-only imports).
//
// The COLUMN SET of every type here comes from database.types.ts, which is
// generated from the real schema (scripts/db-types.sh). A migration that
// adds, drops, or renames a column changes these types without anyone
// editing them, and code that still names the old column fails to compile.
// What this file adds is the domain view the app reasons about: literal
// unions for columns the DB stores as plain text, structured shapes for
// jsonb, and optionality for columns the caller never supplies.
//
// user_id (phase 9) is optional on every client-facing row type: the client
// never sends it (the /api/* handlers stamp it from the verified JWT) and
// never needs to read it (RLS already scopes selects to the signed-in user).

import type { Database, Json, Tables, TablesInsert } from './database.types';

export type { Json, Tables, TablesInsert, TablesUpdate } from './database.types';

type TableName = keyof Database['public']['Tables'];

/** Every key of O must be a column of T — a typo, or a column a migration
 *  dropped, is a compile error at the override rather than a silent lie. */
type ColumnsOf<T extends TableName, O> = { [K in keyof O]: K extends keyof Tables<T> ? unknown : never };

/** Collapse `Omit<…> & O` into one readable object type. */
type Flatten<X> = { [K in keyof X]: X[K] } & {};

/** Domain view of a table row: the generated Row, with the columns in O
 *  replaced by their narrower domain types. */
type Row<T extends TableName, O extends ColumnsOf<T, O> = Record<never, never>> =
  Flatten<Omit<Tables<T>, keyof O> & O>;

/** What a caller supplies for an insert-only log table: the generated Insert
 *  shape minus the columns the handler stamps (user_id) or the DB defaults
 *  (id, logged_at), with the columns in O narrowed. */
type LogRow<T extends TableName, O extends ColumnsOf<T, O> = Record<never, never>> =
  Flatten<Omit<TablesInsert<T>, 'user_id' | 'id' | 'logged_at' | keyof O> & O>;

export type AvatarKey =
  | 'goat' | 'ibex' | 'snow-leopard' | 'eagle' | 'wolf'
  | 'bighorn' | 'marmot' | 'raven' | 'lynx' | 'fox'
  | 'bear' | 'owl' | 'falcon' | 'pika' | 'elk'
  | 'wolverine' | 'cougar' | 'chamois' | 'yak' | 'hare'
  | 'orca' | 'seal' | 'otter' | 'octopus';

// One row per auth user (phase 9). Client-writable fields go through
// /api/profile; the rest are server-managed. coach_goal / coach_context use
// '' for "not set"; onboarding_dismissed_at null = welcome flow never shown.
export type ProfileRow = Row<'profiles', { avatar_key: AvatarKey }>;

export type CompletionRow = Row<'workout_completions', { user_id?: string }>;

export type CompletionLogRow = LogRow<'workout_completion_log', {
  user_id?: string;
  action: 'complete' | 'uncomplete';
}>;

// workout_events. The exercise columns are jsonb holding camelCase payloads
// (Exercise[]); cardio_targets / climbing_targets are the planned targets in
// the same style. recurrence_rule is the canonical RFC 5545 RRULE value (no
// 'RRULE:' prefix — see src/lib/recurrence/); recurring_frequency,
// recurring_days and recurring_end_date are superseded by it.
export type WorkoutEventRow = Row<'workout_events', {
  user_id?: string;
  warmup: unknown[];
  exercises: unknown[];
  cooldown: unknown[];
  /** Optional on the domain side: callers build rows without it. */
  cardio_targets?: unknown;
  /** Optional on the domain side: callers build rows without it. */
  climbing_targets?: unknown;
  /** Provider provenance ('coros'); never set on recurring base rows. */
  source?: string | null;
  /** Library linkage + scoring snapshot (phase 33); unset on non-library events. */
  template_id?: string | null;
  scoring_type?: string | null;
  time_cap_minutes?: number | null;
}>;

// workout_templates (phase 33): the workout library — a workout_events row
// minus calendar placement, plus the scoring config. Exercise columns are
// jsonb camelCase payloads (Exercise[]), same as the event ones.
export type WorkoutTemplateRow = Row<'workout_templates', {
  user_id?: string;
  warmup: unknown[];
  exercises: unknown[];
  cooldown: unknown[];
  /** Optional on the domain side: callers build rows without it. */
  cardio_targets?: unknown;
  /** Optional on the domain side: callers build rows without it. */
  climbing_targets?: unknown;
}>;

// meals (phase 22). Numeric macro columns are nullable — blank form fields
// stay unset rather than becoming zeros.
export type MealRow = Row<'meals', { user_id?: string }>;

// meal_favorites (phase 24): a meals row minus date/time.
export type MealFavoriteRow = Row<'meal_favorites', { user_id?: string }>;

export type MealMutationLogRow = LogRow<'meal_mutations_log', {
  operation: 'create' | 'update' | 'delete';
}>;

// ─── Phase 4: workout tracking rows ──────────────────────────────────────────
// event_id follows the workout_completions convention: for recurring
// occurrences it is the expanded `${baseId}__${date}` id.

// coach_summary: AI-generated post-workout summary, saved once at Finish.
export type WorkoutSessionRow = Row<'workout_sessions', { user_id?: string }>;

export type TrackedSection = 'warmup' | 'exercise' | 'cooldown';

// id and updated_at are server-managed (DB default / stamped by the handler
// on every upsert), so the client builds log rows without them.
// definition_id is stamped on rows logged after phase 8; older rows are
// matched by name+alias.
export type SetLogRow = Row<'workout_set_logs', {
  user_id?: string;
  id?: string;
  updated_at?: string;
  section: TrackedSection;
  definition_id?: string | null;
}>;

export type CardioLogRow = Row<'workout_cardio_logs', {
  user_id?: string;
  id?: string;
  updated_at?: string;
  section: TrackedSection;
  definition_id?: string | null;
}>;

// All overrides NULL = the occurrence at skipped_date is removed. Any
// override set = that occurrence is displayed at override_date (or
// skipped_date when only the time changed) with the overridden times.
export type RecurringExceptionRow = Row<'recurring_exceptions', { user_id?: string }>;

export type EventMutationLogRow = LogRow<'event_mutations_log', {
  operation: 'create' | 'update' | 'delete' | 'delete_instance' | 'update_instance';
}>;

// One row per movement in the exercise library (phase 8) — identity and
// descriptive metadata shared by every referencing event entry.
export type ExerciseDefinitionRow = Row<'exercise_definitions', { user_id?: string }>;

// One row per user per review period (phase 12). Server-only: RLS with no
// policies, written and read exclusively by the review cron. `stats` holds
// the pre-computed ReviewStats / YearlyStats JSON (src/lib/review/types.ts);
// month_index is 1–13 for month rows, null for year rows.
export type ReviewRow = Row<'reviews', {
  user_id?: string;
  period_type: 'month' | 'year';
  stats: unknown;
  email_skipped_reason: 'no-activity' | 'no-email' | null;
}>;

export type DefinitionMutationLogRow = LogRow<'definition_mutations_log', {
  operation: 'create' | 'update' | 'archive' | 'unarchive' | 'delete';
}>;

// ─── Phase 19: objectives & training blocks ──────────────────────────────────
// The semantic layer: an objective is what the training is aimed at, a block
// is a dated stretch of training aimed at it. Block membership for a workout
// is derived from event_date (blocks may not overlap), so no block_id column
// exists on workout_events — see the phase19 migration for why.

// target_date null = undated aspiration. required_capabilities (phase 2 of
// blocks): [{ metric, target, unit }] scored against benchmarks; empty until then.
export type ObjectiveRow = Row<'objectives', {
  user_id?: string;
  discipline: 'alpine' | 'ice' | 'rock' | 'ski' | 'general' | null;
  required_capabilities: unknown[];
  status: 'active' | 'achieved' | 'abandoned';
}>;

// Half-open [start_date, end_date_exclusive), both Mondays — matches Period.
// weekly_targets is a WeeklyTargets jsonb (camelCase payload, like cardio_targets).
export type TrainingBlockRow = Row<'training_blocks', {
  user_id?: string;
  phase: 'base' | 'build' | 'peak' | 'taper' | 'recovery' | 'maintenance' | null;
  weekly_targets: unknown;
}>;

export type BlockMutationLogRow = LogRow<'block_mutations_log', {
  operation: 'create' | 'update' | 'delete';
  resource: 'block' | 'objective';
}>;

// ─── Provider sync (phase 27) ────────────────────────────────────────────────
// COROS today; provider strings widen for Garmin/Apple later.

export type SyncProvider = 'coros';

/** Service-role only (RLS with no policies) — the browser never sees this row,
 *  only the status/timestamp projection returned by /api/provider-sync.
 *  access_token / refresh_token are keyCrypto-encrypted (enc:v1:…), null while
 *  OAuth is pending. last_synced_at is the recorded activity-grab watermark;
 *  the imports ledger is what dedupes. timezone is the IANA zone stamped from
 *  the browser on manual actions (phase29) — how the nightly cron places
 *  activities on calendar dates; auto_sync is the per-connection opt-out and
 *  pending_fill_count the matches awaiting a fill decision (set nightly,
 *  cleared by manual apply). */
export type ProviderConnectionRow = Row<'provider_connections', {
  provider: SyncProvider;
  status: 'pending' | 'connected' | 'expired';
  /** { state, codeVerifier (encrypted), createdAt } during the redirect dance. */
  pending_oauth: Record<string, unknown> | null;
}>;

/** Service-role only. One row per provider activity ever imported. event_id
 *  is the occurrence id when filled; the coros-<activityId> event id when created. */
export type ProviderActivityImportRow = Row<'provider_activity_imports', {
  provider: SyncProvider;
  mode: 'created' | 'filled';
}>;

/** Measured metrics kept out of the calendar read path. Anon SELECT allowed
 *  (per-user policy) so the event detail view can read summaries directly. */
export type ActivityStreamsRow = Row<'activity_streams', {
  user_id?: string;
  provider: SyncProvider;
  /** Scalars: sport, avgHr, maxHr, hrZones, calories, hrv, trainingLoad, vo2max, fileUrls… */
  summary: Record<string, unknown>;
  /** Series, downsampled to ≤ ~2000 points each: { hr: [[sec,bpm]…], gps: [[sec,lat,lon,ele]…] }. */
  streams: Record<string, unknown> | null;
}>;

/** Bridge for storing plain-data interfaces in jsonb columns. Interfaces have
 *  no implicit index signature, so TypeScript refuses `Exercise → Json` even
 *  though every value we store round-trips through JSON.stringify unchanged
 *  (microsoft/TypeScript#15300). Keep this the only unchecked Json cast. */
export function toJson<T extends object>(value: T): Json {
  return value as unknown as Json;
}
