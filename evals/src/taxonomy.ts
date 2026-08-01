import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExerciseDefinition } from '../../src/types/workout';
import { matchDefinitionByName } from '../../src/lib/schedule/definitions';

// Movement-pattern taxonomy: canonical library names (and common ad-hoc names
// under "extras") → movement patterns. This is the mapping that makes
// contraindication checking deterministic. Unknown names resolve to null and
// the constraints checker fails closed with `needs-taxonomy`.

export interface Taxonomy {
  patterns: string[];
  exercises: Record<string, string[]>;
  extras: Record<string, string[]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_PATH = join(here, '..', 'taxonomy', 'movement-patterns.json');

const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

let cached: { taxonomy: Taxonomy; lookup: Map<string, string[]> } | null = null;

export function loadTaxonomy(): Taxonomy {
  return loadTaxonomyIndexed().taxonomy;
}

function loadTaxonomyIndexed(): { taxonomy: Taxonomy; lookup: Map<string, string[]> } {
  if (cached) return cached;
  const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8')) as Taxonomy;
  const lookup = new Map<string, string[]>();
  for (const [name, patterns] of Object.entries(taxonomy.extras)) lookup.set(normalize(name), patterns);
  // Canonical entries win over extras on collision.
  for (const [name, patterns] of Object.entries(taxonomy.exercises)) lookup.set(normalize(name), patterns);
  cached = { taxonomy, lookup };
  return cached;
}

/**
 * Patterns for a model-supplied exercise name. Resolution: alias-aware match
 * against the definitions in play (renames keep working) → taxonomy by
 * canonical name → taxonomy by raw name → null (unknown, fail closed).
 */
export function patternsFor(name: string, definitions: Iterable<ExerciseDefinition>): string[] | null {
  const { lookup } = loadTaxonomyIndexed();
  const def = matchDefinitionByName(name, definitions);
  if (def) {
    const byCanonical = lookup.get(normalize(def.canonicalName));
    if (byCanonical) return byCanonical;
  }
  return lookup.get(normalize(name)) ?? null;
}
