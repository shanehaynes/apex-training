import { describe, it, expect } from 'vitest';
import { linkWithAbove, normalizeSupersets, unlink } from '../supersets';
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
