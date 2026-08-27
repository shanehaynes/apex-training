import type { WorkoutTemplateRow } from '../db/types';
import type { ScoringType, WorkoutTemplate, WorkoutType } from '../../types/workout';

// ─── Row ↔ WorkoutTemplate mapping ───────────────────────────────────────────
// Pure converters between the app's camelCase WorkoutTemplate and the DB's
// snake_case workout_templates columns (phase 33). The column set mirrors
// WORKOUT_TEMPLATE_COLUMNS in api/_lib/allowlist.ts — pinned together by
// api/__tests__/allowlist.test.ts.

type TemplateRowInsert = Omit<WorkoutTemplateRow, 'created_at' | 'updated_at'>;

/** UUID, not a slug: template ids are global identity for score history and
 *  must never collide across users composing at the same instant. */
export function mintTemplateId(): string {
  return `wt-${crypto.randomUUID()}`;
}

export function templateToRow(t: WorkoutTemplate): TemplateRowInsert {
  return {
    id:                 t.id,
    title:              t.title,
    type:               t.type,
    scoring_type:       t.scoringType,
    time_cap_minutes:   t.timeCapMinutes ?? null,
    estimated_duration: t.estimatedDuration,
    difficulty:         t.difficulty,
    description:        t.description,
    warmup:             (t.warmup ?? []) as unknown[],
    exercises:          t.exercises as unknown[],
    cooldown:           (t.cooldown ?? []) as unknown[],
    location:           t.location ?? null,
    tags:               t.tags,
    equipment:          t.equipment ?? [],
    cardio_targets:     t.cardioTargets,
    climbing_targets:   t.climbingTargets,
    archived_at:        t.archivedAt ?? null,
  };
}

export function rowToTemplate(row: WorkoutTemplateRow): WorkoutTemplate {
  return {
    id:                row.id,
    title:             row.title,
    type:              row.type as WorkoutType,
    scoringType:       row.scoring_type as ScoringType,
    timeCapMinutes:    row.time_cap_minutes ?? undefined,
    estimatedDuration: row.estimated_duration,
    difficulty:        row.difficulty as WorkoutTemplate['difficulty'],
    description:       row.description,
    warmup:            (row.warmup ?? []) as WorkoutTemplate['warmup'],
    exercises:         (row.exercises ?? []) as WorkoutTemplate['exercises'],
    cooldown:          (row.cooldown ?? []) as WorkoutTemplate['cooldown'],
    location:          row.location ?? undefined,
    tags:              row.tags ?? [],
    equipment:         row.equipment ?? [],
    cardioTargets:     (row.cardio_targets ?? undefined) as WorkoutTemplate['cardioTargets'],
    climbingTargets:   (row.climbing_targets ?? undefined) as WorkoutTemplate['climbingTargets'],
    archivedAt:        row.archived_at ?? undefined,
    updatedAt:         row.updated_at,
  };
}

/**
 * Case- and whitespace-insensitive title match, the meal-favorites upsert
 * convention: saving "murph" when "MURPH" exists reuses the existing
 * template's id, so "save again" overwrites instead of duplicating — and
 * score history stays on one id. Exact match only, never fuzzy (the
 * exercise-library rule: a wrong merge fuses PR histories).
 */
export function matchTemplateByTitle(
  templates: Iterable<WorkoutTemplate>,
  title: string,
): WorkoutTemplate | undefined {
  const wanted = normalizeTitle(title);
  if (!wanted) return undefined;
  for (const t of templates) {
    if (normalizeTitle(t.title) === wanted) return t;
  }
  return undefined;
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
