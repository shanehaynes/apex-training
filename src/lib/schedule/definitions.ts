import type { Exercise, ExerciseCategory, ExerciseDefinition, WorkoutEvent } from '../../types/workout';
import type { ExerciseDefinitionRow } from '../db/types';
import { baseIdOf } from './occurrence';

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

/**
 * How many distinct workouts reference a definition — the blast radius shown
 * before shared edits. Occurrences of a recurring series collapse to their
 * base event, so a series counts once.
 */
export function countDefinitionReferences(definitionId: string, events: WorkoutEvent[]): number {
  const bases = new Set<string>();
  for (const event of events) {
    const all = [...(event.warmup ?? []), ...event.exercises, ...(event.cooldown ?? [])];
    if (all.some(e => e.definitionId === definitionId)) bases.add(baseIdOf(event.id));
  }
  return bases.size;
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

/** Slug for a new definition id, e.g. "90/90 Hip Stretch" → "90-90-hip-stretch". */
export function slugifyName(name: string): string {
  return normalize(name).replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

/**
 * Exact (case/whitespace-insensitive) match of a name against every
 * definition's canonical name and aliases. Deliberately no fuzzy matching —
 * a wrong merge corrupts shared notes and fuses PR histories; unmatched
 * names surface to the user as "new exercise" instead (spec §5).
 */
export function matchDefinitionByName(
  name: string,
  defs: Iterable<ExerciseDefinition>,
): ExerciseDefinition | undefined {
  const wanted = normalize(name);
  for (const def of defs) {
    if (normalize(def.canonicalName) === wanted) return def;
    if (def.aliases.some(a => normalize(a) === wanted)) return def;
  }
  return undefined;
}

// ─── Entry authoring (shared by the coach tools and the UI picker) ────────────

const PER_SIDE_RE = /\beach\b|\bper\s+(side|leg|arm)\b|\btotal\b/i;

/** Whether a count string states its side convention ("5 each leg", "10 total"). */
export function hasPerSideCount(text: string | null | undefined): boolean {
  return !!text && PER_SIDE_RE.test(text);
}

/** Prescription fields an author may supply when adding an exercise to an event. */
export interface PrescriptionOverrides {
  sets?: number;
  reps?: string;
  duration?: string;
  weight?: string;
  restPeriod?: string;
  notes?: string;
}

/**
 * A new event entry referencing a definition: canonical name/category
 * snapshots, prescription from the overrides with gaps prefilled from the
 * definition's defaults (insert-time copy — the definition is out of the
 * loop afterward).
 */
export function entryFromDefinition(
  def: ExerciseDefinition,
  id: string,
  overrides: PrescriptionOverrides = {},
): Exercise {
  return {
    id,
    definitionId: def.id,
    name: def.canonicalName,
    category: def.category,
    sets: overrides.sets ?? def.defaultSets,
    reps: overrides.reps ?? def.defaultReps,
    duration: overrides.duration ?? def.defaultDuration,
    weight: overrides.weight ?? def.defaultWeight,
    restPeriod: overrides.restPeriod ?? def.defaultRest,
    notes: overrides.notes,
  };
}

/**
 * Entry id that collides with none of the section's existing ids. Existing
 * entries keep their ids forever — workout_set_logs keys on exercise_id, so
 * a changed id orphans that occurrence's logged sets.
 */
export function uniqueEntryId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** camelCase definition fields → snake_case row columns, for API payloads. */
export function definitionFieldsToRow(fields: Partial<ExerciseDefinition>): Record<string, unknown> {
  const map: Record<string, string> = {
    canonicalName: 'canonical_name',
    aliases: 'aliases',
    category: 'category',
    muscleGroups: 'muscle_groups',
    equipment: 'equipment',
    imageUrl: 'image_url',
    techniqueNotes: 'technique_notes',
    isUnilateral: 'is_unilateral',
    defaultSets: 'default_sets',
    defaultReps: 'default_reps',
    defaultDuration: 'default_duration',
    defaultWeight: 'default_weight',
    defaultRest: 'default_rest',
    archivedAt: 'archived_at',
  };
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id' || value === undefined) continue;
    row[map[key] ?? key] = value;
  }
  return row;
}

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
