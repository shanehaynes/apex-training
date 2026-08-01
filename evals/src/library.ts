import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExerciseDefinition } from '../../src/types/workout';
import { rowToDefinition } from '../../src/lib/schedule/definitions';
import type { ExerciseDefinitionRow } from '../../src/lib/db/types';

// The 69-entry exercise library, loaded from the reviewed seed JSON. This is
// the default fixture library and the substrate the movement taxonomy maps.

const here = dirname(fileURLToPath(import.meta.url));
const LIBRARY_PATH = join(here, '..', '..', 'supabase', 'exercise_definitions_review.json');

let cached: ExerciseDefinition[] | null = null;

export function loadLibrary(): ExerciseDefinition[] {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8')) as { definitions: ExerciseDefinitionRow[] } | ExerciseDefinitionRow[];
  const rows = Array.isArray(raw) ? raw : raw.definitions;
  cached = rows.map(rowToDefinition);
  return cached;
}

export function libraryMap(definitions: ExerciseDefinition[] = loadLibrary()): Map<string, ExerciseDefinition> {
  return new Map(definitions.map(d => [d.id, d]));
}
