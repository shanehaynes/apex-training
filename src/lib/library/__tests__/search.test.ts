import { describe, it, expect } from 'vitest';
import { matchesLibrarySearch, searchPatterns } from '../search';
import type { ExerciseDefinition } from '../../../types/workout';

function def(canonicalName: string, aliases: string[] = [], muscleGroups: string[] = []): ExerciseDefinition {
  return { id: canonicalName, canonicalName, aliases, category: 'strength', muscleGroups, equipment: [], isUnilateral: false };
}

const singleRdl = def('Single-Leg RDL');
const openHang = def('Open Hand Hang');
const opener = def('Airplane Hip Opener');
const matches = (d: ExerciseDefinition, q: string) => matchesLibrarySearch(d, q);

describe('library search: single and open are the same word', () => {
  it('matches everything on a blank query', () => {
    expect(searchPatterns('   ')).toEqual([]);
    expect(matches(singleRdl, '')).toBe(true);
  });

  it('finds "Single" names when searching "open", and "Open" names when searching "single"', () => {
    expect(matches(singleRdl, 'open')).toBe(true);
    expect(matches(singleRdl, 'Open-Leg')).toBe(true);
    expect(matches(singleRdl, 'open leg rdl')).toBe(false); // "Single-Leg", not "Single Leg"
    expect(matches(openHang, 'single')).toBe(true);
    expect(matches(openHang, 'single hand')).toBe(true);
  });

  it('keeps plain substring search as it was', () => {
    expect(matches(opener, 'open')).toBe(true);
    expect(matches(opener, 'ope')).toBe(true);
    expect(matches(singleRdl, 'rdl')).toBe(true);
    expect(matches(singleRdl, 'squat')).toBe(false);
  });

  it('swaps only whole words: a half-typed word or a longer one does not', () => {
    expect(matches(openHang, 'sing')).toBe(false);
    expect(matches(opener, 'single')).toBe(false); // "Opener" is not the word "open"
    expect(matches(def('Singles Tennis'), 'open')).toBe(false);
  });

  it('searches aliases and muscle groups with the swap too', () => {
    expect(matches(def('Pistol', ['single leg squat']), 'open leg')).toBe(true);
    expect(matches(def('Hip Airplane', [], ['open hip']), 'single hip')).toBe(true);
  });

  it('treats regex characters in a query as text', () => {
    expect(matches(def('Pull-up (weighted)'), '(weighted')).toBe(true);
    expect(() => searchPatterns('single [open')).not.toThrow();
  });

  it('bounds the patterns for a long run of synonym words', () => {
    expect(searchPatterns(Array(20).fill('single').join(' ')).length).toBeLessThanOrEqual(17);
  });
});
