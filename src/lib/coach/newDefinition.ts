import { hasPerSideCount, matchDefinitionByName, slugifyName } from '../schedule/definitions.js';
import type { CreateDefinitionInput } from '../schedule/types.js';
import type { ExerciseCategory, ExerciseDefinition } from '../../types/workout.js';

// create_exercise_definition's input check, shared by the executor
// (tools.ts), its confirmation-card label and its preview (preview.ts) — so
// the card never shows a clean "new exercise" for a call the executor is
// going to refuse. Kept out of tools.ts so preview.ts does not import the
// executor graph.

export const DEFINITION_NAME_MAX = 80;

const CATEGORIES: readonly ExerciseCategory[] = ['strength', 'stretch', 'cardio', 'skill', 'mobility', 'climbing'];

export type NewDefinition = Omit<CreateDefinitionInput, 'triggeredBy'> & { aliases: string[] };

const cleanName = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = cleanName(item);
    if (s && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The library entry a proposed name would collide with: an exact
 * canonical/alias match (matchDefinitionByName), or one whose name slugs the
 * same — "One Arm Aussie Pull-up" vs "One-Arm Aussie Pull-Up" is a variant
 * spelling, and the two would also fight over the slug id the new row gets.
 * Archived entries count: their id is still taken.
 */
export function collidingDefinition(
  name: string,
  definitions: Map<string, ExerciseDefinition>,
): ExerciseDefinition | undefined {
  const exact = matchDefinitionByName(name, definitions.values());
  if (exact) return exact;
  const slug = slugifyName(name);
  if (!slug) return undefined;
  for (const def of definitions.values()) {
    if (def.id === slug || slugifyName(def.canonicalName) === slug) return def;
    if (def.aliases.some(a => slugifyName(a) === slug)) return def;
  }
  return undefined;
}

function collisionReason(name: string, def: ExerciseDefinition): string {
  if (def.archivedAt) {
    return `"${name}" matches "${def.canonicalName}", which is archived in the exercise library. ` +
      'Ask the athlete to restore it from the library rather than creating a duplicate.';
  }
  return `"${name}" is already in the exercise library as "${def.canonicalName}". ` +
    'Reference it by that exact name, or change it with update_exercise_definition.';
}

/**
 * Validate a create_exercise_definition input against the live library and
 * map it to the definition fields. Refuses (with a reason the model can act
 * on) a missing or overlong name, an unknown category, any name or alias
 * that collides with an existing entry, and a unilateral default count that
 * does not state its side convention.
 */
export function parseNewDefinition(
  input: Record<string, unknown>,
  definitions: Map<string, ExerciseDefinition>,
): { ok: true; fields: NewDefinition } | { ok: false; reason: string } {
  const canonicalName = cleanName(input.canonical_name);
  if (!canonicalName) return { ok: false, reason: 'canonical_name is required.' };
  if (canonicalName.length > DEFINITION_NAME_MAX) {
    return { ok: false, reason: `canonical_name is ${canonicalName.length} characters; keep it to ${DEFINITION_NAME_MAX}.` };
  }
  if (!slugifyName(canonicalName)) {
    return { ok: false, reason: `"${canonicalName}" needs at least one letter or digit.` };
  }
  const category = input.category as ExerciseCategory;
  if (!CATEGORIES.includes(category)) {
    return { ok: false, reason: `category must be one of: ${CATEGORIES.join(', ')}.` };
  }

  const existing = collidingDefinition(canonicalName, definitions);
  if (existing) return { ok: false, reason: collisionReason(canonicalName, existing) };

  const aliases = stringList(input.aliases).filter(a => slugifyName(a) !== slugifyName(canonicalName));
  for (const alias of aliases) {
    if (alias.length > DEFINITION_NAME_MAX) {
      return { ok: false, reason: `Alias "${alias.slice(0, 20)}…" is over ${DEFINITION_NAME_MAX} characters.` };
    }
    const taken = collidingDefinition(alias, definitions);
    if (taken) {
      return {
        ok: false,
        reason: `Alias "${alias}" already names "${taken.canonicalName}" in the library — an alias there would fuse the two histories. Drop it and retry.`,
      };
    }
  }

  const defaultReps = optionalText(input.default_reps);
  const defaultDuration = optionalText(input.default_duration);
  const counted = [defaultReps, defaultDuration].filter(Boolean).join(' ');
  // Same inference the implicit create path uses (tools.ts buildExerciseEntries)
  // when the model does not say: a per-side count implies a unilateral movement.
  const isUnilateral = typeof input.is_unilateral === 'boolean' ? input.is_unilateral : hasPerSideCount(counted);
  if (isUnilateral) {
    const bad = [defaultReps, defaultDuration].filter((c): c is string => !!c && !hasPerSideCount(c));
    if (bad.length) {
      return {
        ok: false,
        reason: `Unilateral exercises need per-side counts: "${bad[0]}" — state it per side ("${bad[0]} each side") or as "total".`,
      };
    }
  }

  const defaultSets = typeof input.default_sets === 'number' && Number.isFinite(input.default_sets) && input.default_sets > 0
    ? Math.round(input.default_sets)
    : undefined;

  return {
    ok: true,
    fields: {
      canonicalName,
      category,
      aliases,
      muscleGroups: stringList(input.muscle_groups),
      equipment: stringList(input.equipment),
      techniqueNotes: optionalText(input.technique_notes),
      isUnilateral,
      defaultSets,
      defaultReps,
      defaultDuration,
      defaultWeight: optionalText(input.default_weight),
      defaultRest: optionalText(input.default_rest),
    },
  };
}
