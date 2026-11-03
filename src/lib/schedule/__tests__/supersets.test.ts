import { describe, it, expect } from 'vitest';
import { linkWithAbove, moveEntry, normalizeSupersets, unlink } from '../supersets';
import type { Exercise } from '../../../types/workout';

const ex = (id: string, superset?: string): Exercise => ({
  id, name: id, category: 'strength', ...(superset ? { superset } : {}),
});

const labels = (entries: Exercise[]) => entries.map(e => e.superset);

describe('normalizeSupersets', () => {
  it('re-letters runs in order of appearance', () => {
    const out = normalizeSupersets([ex('a', 'X'), ex('b', 'X'), ex('c'), ex('d', 'Q'), ex('e', 'Q')]);
    expect(labels(out)).toEqual(['A', 'A', undefined, 'B', 'B']);
  });

  it('clears singleton labels', () => {
    expect(labels(normalizeSupersets([ex('a', 'A'), ex('b'), ex('c', 'A')])))
      .toEqual([undefined, undefined, undefined]);
  });

  it('splits a label separated by a reorder into distinct groups', () => {
    const out = normalizeSupersets([ex('a', 'A'), ex('b', 'A'), ex('c'), ex('d', 'A'), ex('e', 'A')]);
    expect(labels(out)).toEqual(['A', 'A', undefined, 'B', 'B']);
  });

  it('keeps identity for untouched entries', () => {
    const plain = ex('a');
    const grouped = [ex('b', 'A'), ex('c', 'A')];
    const out = normalizeSupersets([plain, ...grouped]);
    expect(out[0]).toBe(plain);
    expect(out[1]).toBe(grouped[0]);
  });
});

describe('linkWithAbove / unlink', () => {
  it('pairs an entry with the one above it', () => {
    expect(labels(linkWithAbove([ex('a'), ex('b')], 'b'))).toEqual(['A', 'A']);
  });

  it('joins an existing group above', () => {
    const out = linkWithAbove([ex('a', 'A'), ex('b', 'A'), ex('c')], 'c');
    expect(labels(out)).toEqual(['A', 'A', 'A']);
  });

  it('is a no-op on the first entry', () => {
    const entries = [ex('a'), ex('b')];
    expect(linkWithAbove(entries, 'a')).toBe(entries);
  });

  it('unlink dissolves a pair and re-letters what remains', () => {
    const out = unlink([ex('a', 'A'), ex('b', 'A'), ex('c', 'B'), ex('d', 'B')], 'a');
    expect(labels(out)).toEqual([undefined, undefined, 'A', 'A']);
  });

  it('unlink from a trio leaves the remaining pair grouped', () => {
    const out = unlink([ex('a', 'A'), ex('b', 'A'), ex('c', 'A')], 'c');
    expect(labels(out)).toEqual(['A', 'A', undefined]);
  });
});

describe('moveEntry', () => {
  const ids = (entries: Exercise[]) => entries.map(e => e.id);
  const ten = Array.from({ length: 10 }, (_, i) => ex(`e${i + 1}`));

  it('moves the tenth entry to the top in one step', () => {
    expect(ids(moveEntry(ten, 9, 0))).toEqual(['e10', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
  });

  it('moves down as well as up', () => {
    expect(ids(moveEntry([ex('a'), ex('b'), ex('c')], 0, 2))).toEqual(['b', 'c', 'a']);
  });

  it('returns the same array for a no-op or out-of-range move', () => {
    const list = [ex('a'), ex('b')];
    expect(moveEntry(list, 1, 1)).toBe(list);
    expect(moveEntry(list, -1, 0)).toBe(list);
    expect(moveEntry(list, 0, 2)).toBe(list);
  });

  it('re-letters groups a move splits or strands', () => {
    // Pulling b out of the a+b pair leaves a alone, so neither keeps a label;
    // c+d stay a pair and become A.
    const out = moveEntry([ex('a', 'A'), ex('b', 'A'), ex('c', 'B'), ex('d', 'B'), ex('e')], 1, 4);
    expect(ids(out)).toEqual(['a', 'c', 'd', 'e', 'b']);
    expect(labels(out)).toEqual([undefined, 'A', 'A', undefined, undefined]);
  });
});
