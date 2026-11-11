import type { ExerciseDefinition } from '../../types/workout';

/**
 * Words the library search treats as the same word. Each group is a set of
 * interchangeable whole words: a query that uses one also matches names that
 * use any other, so "single" finds "Open …" movements and "open" finds
 * "Single …" ones. Shane asked for single ↔ open (2026-11-11).
 */
export const SEARCH_SYNONYMS: readonly (readonly string[])[] = [
  ['single', 'open'],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const synonymsOf = new Map<string, readonly string[]>(
  SEARCH_SYNONYMS.flatMap(group => group.map(word => [word, group] as const)),
);
const SYNONYM_WORD = new RegExp(`\\b(${[...synonymsOf.keys()].map(escape).join('|')})\\b`, 'g');

/**
 * What a query matches, as patterns: the query itself as a plain substring
 * (the search as it always was), then one pattern per synonym swap. Only a
 * whole word of the query is swapped, so a half-typed "sing" stays as typed,
 * and the swapped-in word must be a whole word in the name too, so "single"
 * finds "Open Hand Hang" but not "Hip Opener".
 */
export function searchPatterns(query: string): RegExp[] {
  const base = query.trim().toLowerCase();
  if (!base) return [];
  // Split into literal text and synonym words: odd indexes are the words.
  const parts = base.split(SYNONYM_WORD);
  const variants: string[][] = [[]];
  parts.forEach((part, i) => {
    // Swap at most the first four synonym words, so a pasted run of them
    // cannot multiply the patterns without bound.
    const options = i % 2 === 1 && i < 9
      ? (synonymsOf.get(part) ?? [part]).map(w => `\\b${escape(w)}\\b`)
      : [escape(part)];
    const next: string[][] = [];
    for (const v of variants) for (const o of options) next.push([...v, o]);
    variants.splice(0, variants.length, ...next);
  });
  const plain = escape(base);
  const swapped = variants
    .map(v => v.join(''))
    .filter(src => src.replace(/\\b/g, '') !== plain);
  return [new RegExp(plain), ...swapped.map(src => new RegExp(src))];
}

/**
 * Whether a library movement matches a search: any pattern in its name, an
 * alias or a muscle group. An empty query matches everything.
 */
export function matchesLibrarySearch(def: ExerciseDefinition, query: string): boolean {
  const patterns = searchPatterns(query);
  if (patterns.length === 0) return true;
  const fields = [def.canonicalName, ...def.aliases, ...def.muscleGroups].map(f => f.toLowerCase());
  return patterns.some(p => fields.some(f => p.test(f)));
}
