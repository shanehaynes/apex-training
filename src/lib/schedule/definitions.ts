import type { Exercise, ExerciseCategory, ExerciseDefinition, WorkoutEvent } from '../../types/workout';
import type { ExerciseDefinitionRow } from '../db/types';

// ─── Exercise definition resolution ───────────────────────────────────────────
// Pure helpers implementing EXERCISE_LIBRARY_SPEC.md §2.2/§2.3: event entries
// reference a definition by id; display fields resolve from the definition
// with the entry's embedded snapshots as fallback, and history matching
// unions a definition's canonical name with its aliases so renames never
// fork PR lineage. Kept free of React/Supabase so it is unit-testable.

export function rowToDefinition(row: ExerciseDefinitionRow): ExerciseDefinition {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    aliases: row.aliases ?? [],
    category: row.category as ExerciseCategory,
    muscleGroups: row.muscle_groups ?? [],
    equipment: row.equipment ?? [],
    imageUrl: row.image_url ?? undefined,
    techniqueNotes: row.technique_notes ?? undefined,
    isUnilateral: row.is_unilateral,
    defaultSets: row.default_sets ?? undefined,
    defaultReps: row.default_reps ?? undefined,
    defaultDuration: row.default_duration ?? undefined,
    defaultWeight: row.default_weight ?? undefined,
    defaultRest: row.default_rest ?? undefined,
    archivedAt: row.archived_at ?? undefined,
  };
}

/**
 * The §2.2 resolution rule: definition fields win when the reference
 * resolves; the entry's snapshots (and the entry itself, untouched) are the
 * fallback for pre-migration data, ad-hoc entries, and missing definitions.
 */
export function resolveExercise(entry: Exercise, defs: Map<string, ExerciseDefinition>): Exercise {
  const def = entry.definitionId ? defs.get(entry.definitionId) : undefined;
  if (!def) return entry;
  return {
    ...entry,
    name: def.canonicalName,
    category: def.category,
    muscleGroups: def.muscleGroups.length ? def.muscleGroups : entry.muscleGroups,
    imageUrl: def.imageUrl ?? entry.imageUrl,
    techniqueNotes: def.techniqueNotes,
  };
}

/** Event with every section's entries resolved. Returns the event unchanged when there is nothing to resolve. */
export function resolveEventExercises(event: WorkoutEvent, defs: Map<string, ExerciseDefinition>): WorkoutEvent {
  if (defs.size === 0) return event;
  return {
    ...event,
    warmup: event.warmup?.map(e => resolveExercise(e, defs)),
    exercises: event.exercises.map(e => resolveExercise(e, defs)),
    cooldown: event.cooldown?.map(e => resolveExercise(e, defs)),
  };
}

// ─── Alias-aware history matching (§2.3) ──────────────────────────────────────

const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export interface AliasIndex {
  /** normalize(any known spelling) → canonical name */
  toCanonical: Map<string, string>;
  /** canonical name → every known spelling (canonical + aliases) */
  spellings: Map<string, string[]>;
}

export function buildAliasIndex(
  defs: Iterable<Pick<ExerciseDefinition, 'canonicalName' | 'aliases'>>,
): AliasIndex {
  const toCanonical = new Map<string, string>();
  const spellings = new Map<string, string[]>();
  for (const def of defs) {
    const all = [def.canonicalName, ...def.aliases];
    spellings.set(def.canonicalName, all);
    for (const spelling of all) toCanonical.set(normalize(spelling), def.canonicalName);
  }
  return { toCanonical, spellings };
}

/** Canonical name for any known spelling; unknown names pass through unchanged. */
export function canonicalNameOf(name: string, index: AliasIndex): string {
  return index.toCanonical.get(normalize(name)) ?? name;
}

/**
 * Expand exercise names to every spelling history rows might carry, for the
 * `.in('exercise_name', …)` history fetch. Unknown names are kept as-is.
 */
export function expandNamesWithAliases(names: string[], index: AliasIndex): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const canonical = index.toCanonical.get(normalize(name));
    for (const spelling of (canonical && index.spellings.get(canonical)) ?? [name]) out.add(spelling);
  }
  return [...out];
}

/**
 * In-memory canonicalization of fetched history rows so PR / last-performance
 * grouping (keyed by exercise_name) unifies pre-rename spellings. Never
 * written back — the append-only logs keep their original names.
 */
export function canonicalizeLogNames<T extends { exercise_name: string }>(rows: T[], index: AliasIndex): T[] {
  if (index.toCanonical.size === 0) return rows;
  return rows.map(row => {
    const canonical = canonicalNameOf(row.exercise_name, index);
    return canonical === row.exercise_name ? row : { ...row, exercise_name: canonical };
  });
}
