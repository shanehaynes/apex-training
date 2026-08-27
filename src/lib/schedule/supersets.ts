import type { Exercise } from '../../types/workout';

// ─── Superset grouping ───────────────────────────────────────────────────────
// A superset is CONSECUTIVE entries in one section sharing Exercise.superset.
// These helpers are the only writers of that field: they keep labels
// canonical (A, B, … in order of appearance), enforce adjacency after
// reorders, and clear singleton labels — a superset of one is meaningless.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Re-letter a section's groups: consecutive runs of a shared truthy label
 * become A, B, … in order; a run of one loses its label; a label split apart
 * by a reorder becomes two runs (each re-lettered, singletons cleared).
 * Entries are returned identity-stable when nothing about them changes.
 */
export function normalizeSupersets(entries: Exercise[]): Exercise[] {
  const runs: Exercise[][] = [];
  for (const entry of entries) {
    const run = runs.at(-1);
    if (entry.superset && run && run[0].superset === entry.superset) run.push(entry);
    else runs.push([entry]);
  }

  let next = 0;
  return runs.flatMap(run => {
    const label = run.length > 1 && run[0].superset ? LETTERS[next++ % LETTERS.length] : undefined;
    return run.map(entry =>
      entry.superset === label ? entry : label ? { ...entry, superset: label } : stripLabel(entry));
  });
}

function stripLabel(entry: Exercise): Exercise {
  if (entry.superset === undefined) return entry;
  const { superset: _s, ...rest } = entry;
  return rest;
}

/** Group this entry with the one above it (joining its group, or forming a
 *  new pair). No-op on the first entry of a section. */
export function linkWithAbove(entries: Exercise[], id: string): Exercise[] {
  const idx = entries.findIndex(e => e.id === id);
  if (idx <= 0) return entries;
  const label = entries[idx - 1].superset ?? '*';
  return normalizeSupersets(entries.map((e, i) =>
    (i === idx || i === idx - 1) ? { ...e, superset: label } : e));
}

/** Pull this entry out of its group (the rest re-letter, singletons clear). */
export function unlink(entries: Exercise[], id: string): Exercise[] {
  return normalizeSupersets(entries.map(e => (e.id === id ? stripLabel(e) : e)));
}
