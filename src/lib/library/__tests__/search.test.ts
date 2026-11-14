import { describe, it, expect } from 'vitest';
import { librarySearch, matchesLibrarySearch, searchPatterns } from '../search';
import type { ExerciseDefinition } from '../../../types/workout';

function def(canonicalName: string, aliases: string[] = [], muscleGroups: string[] = []): ExerciseDefinition {
  return { id: canonicalName, canonicalName, aliases, category: 'strength', muscleGroups, equipment: [], isUnilateral: false };
}

// Names from Shane's own library.
const singleRdl = def('Single-Leg RDL');
const singleCarry = def('Single Hand Farmer Carry');
const oneArmRow = def('Standing One Arm Cabel Rows');
const oneArmPress = def('One Arm Incline Dumbell Press w Extension');
const prone = def('Prone YTWs');
const matches = (d: ExerciseDefinition, q: string) => matchesLibrarySearch(d, q);

describe('library search: single and one are the same word', () => {
  it('matches everything on a blank query', () => {
    expect(searchPatterns('   ')).toEqual([]);
    expect(matches(singleRdl, '')).toBe(true);
  });

  it('finds "One Arm" names when searching "single", and "Single" names when searching "one"', () => {
    expect(matches(oneArmRow, 'single')).toBe(true);
    expect(matches(oneArmPress, 'Single Arm')).toBe(true);
    expect(matches(singleRdl, 'one')).toBe(true);
    expect(matches(singleRdl, 'one-leg')).toBe(true);
    expect(matches(singleCarry, 'one hand')).toBe(true);
  });

  it('keeps plain substring search as it was', () => {
    expect(matches(prone, 'one')).toBe(true); // "prONE", the plain substring
    expect(matches(singleRdl, 'rdl')).toBe(true);
    expect(matches(singleRdl, 'squat')).toBe(false);
  });

  it('swaps only whole words: a half-typed word or a longer one does not', () => {
    expect(matches(oneArmRow, 'sing')).toBe(false);
    expect(matches(prone, 'single')).toBe(false); // "Prone" is not the word "one"
    expect(matches(def('Singles Tennis'), 'one')).toBe(false);
  });

  it('searches aliases and muscle groups with the swap too', () => {
    expect(matches(def('Pistol', ['single leg squat']), 'one leg')).toBe(true);
    expect(matches(def('Hip Airplane', [], ['one hip']), 'single hip')).toBe(true);
  });

  it('treats regex characters in a query as text', () => {
    expect(matches(def('Pull-up (weighted)'), '(weighted')).toBe(true);
    expect(() => searchPatterns('single [one')).not.toThrow();
  });

  it('bounds the patterns for a long run of synonym words', () => {
    expect(searchPatterns(Array(20).fill('single').join(' ')).length).toBeLessThanOrEqual(17);
  });

  it('gives one reusable matcher per query', () => {
    const search = librarySearch('one');
    expect([singleRdl, oneArmRow, def('Bench Press')].filter(search).map(d => d.canonicalName))
      .toEqual(['Single-Leg RDL', 'Standing One Arm Cabel Rows']);
  });
});
