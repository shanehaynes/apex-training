import { describe, it, expect } from 'vitest';
import { dequeue, enqueue, entriesFromDefinitions } from '../pickerQueue';
import type { ExerciseDefinition } from '../../../types/workout';

function def(id: string, canonicalName: string): ExerciseDefinition {
  return { id, canonicalName, aliases: [], category: 'strength', muscleGroups: [], equipment: [], isUnilateral: false };
}

const bench = def('bench-press', 'Bench Press');
const fold = def('pancake-fold', 'Pancake Fold');

describe('picker queue', () => {
  it('keeps picks in the order they were made', () => {
    const q = enqueue(enqueue([], bench), fold);
    expect(q.map(p => p.def.canonicalName)).toEqual(['Bench Press', 'Pancake Fold']);
  });

  it('queues the same movement twice under two keys, and removes one copy alone', () => {
    const q = enqueue(enqueue(enqueue([], bench), fold), bench);
    expect(new Set(q.map(p => p.key)).size).toBe(3);
    const firstBench = q[0].key;
    const left = dequeue(q, firstBench);
    expect(left.map(p => p.def.canonicalName)).toEqual(['Pancake Fold', 'Bench Press']);
  });

  it('never reuses a key still in the list after a removal', () => {
    let q = enqueue(enqueue([], bench), fold);
    q = dequeue(q, q[0].key);
    q = enqueue(q, bench);
    expect(new Set(q.map(p => p.key)).size).toBe(q.length);
  });
});

describe('entriesFromDefinitions', () => {
  it('builds one entry per pick, in order', () => {
    const entries = entriesFromDefinitions([bench, fold], []);
    expect(entries.map(e => e.name)).toEqual(['Bench Press', 'Pancake Fold']);
    expect(entries.map(e => e.id)).toEqual(['bench-press', 'pancake-fold']);
  });

  it('gives a movement picked twice, or already in the section, ids that collide with nothing', () => {
    const entries = entriesFromDefinitions([bench, bench], ['bench-press']);
    expect(entries.map(e => e.id)).toEqual(['bench-press-2', 'bench-press-3']);
  });

  it('adds nothing for an empty pick list', () => {
    expect(entriesFromDefinitions([], ['bench-press'])).toEqual([]);
  });
});
