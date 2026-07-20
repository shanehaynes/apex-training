import { describe, expect, it } from 'vitest';
import { ascentStyleLabel, ascentStylesFor, climbStyleLabel, maxGradeOf, parseGrade, resolveClimbingTargets, sectionLabels } from '../climbing';
import type { Exercise } from '../../types/workout';

const pitch = (id: string, grade?: string): Exercise => ({
  id, name: 'Sport', category: 'climbing', climbStyle: 'sport', grade,
});

describe('parseGrade', () => {
  it('parses YDS grades with letters and modifiers', () => {
    expect(parseGrade('5.9')!.scale).toBe('yds');
    expect(parseGrade('5.11a')!.rank).toBeLessThan(parseGrade('5.11d')!.rank);
    expect(parseGrade('5.9+')!.rank).toBeGreaterThan(parseGrade('5.9')!.rank);
    expect(parseGrade('5.9+')!.rank).toBeLessThan(parseGrade('5.10a')!.rank);
    // A bare 5.10 sits inside the 5.10 letter range, above 5.10a.
    expect(parseGrade('5.10')!.rank).toBeGreaterThan(parseGrade('5.10a')!.rank);
    expect(parseGrade('5.10')!.rank).toBeLessThan(parseGrade('5.10d')!.rank);
  });

  it('parses V, WI/AI, and M grades case-insensitively', () => {
    expect(parseGrade('V5')).toEqual({ scale: 'boulder', rank: 50 });
    expect(parseGrade('vb')!.rank).toBeLessThan(parseGrade('V0')!.rank);
    expect(parseGrade('WI4+')!.rank).toBeGreaterThan(parseGrade('wi4')!.rank);
    expect(parseGrade('AI3')!.scale).toBe('ice');
    expect(parseGrade('M6')).toEqual({ scale: 'mixed', rank: 60 });
  });

  it('rejects non-grades', () => {
    expect(parseGrade(undefined)).toBeNull();
    expect(parseGrade('')).toBeNull();
    expect(parseGrade('hard')).toBeNull();
    expect(parseGrade('185lb')).toBeNull();
  });
});

describe('maxGradeOf', () => {
  it('returns the hardest grade within one scale', () => {
    expect(maxGradeOf(['5.9', '5.11a', '5.10c'])).toBe('5.11a');
    expect(maxGradeOf(['V2', 'V5', 'V3'])).toBe('V5');
  });

  it('reports per-scale maxes when scales mix', () => {
    expect(maxGradeOf(['5.11a', 'V5', '5.9'])).toBe('5.11a · V5');
  });

  it('skips blanks and unparseable text', () => {
    expect(maxGradeOf([undefined, '', 'sandbagged', '5.8'])).toBe('5.8');
    expect(maxGradeOf([undefined, 'unknown'])).toBeUndefined();
  });
});

describe('resolveClimbingTargets', () => {
  const exercises = [pitch('p1', '5.10a'), pitch('p2', '5.11b'), pitch('p3')];

  it('derives max grade and pitch count from the pitch list', () => {
    expect(resolveClimbingTargets({ exercises })).toEqual({ maxGrade: '5.11b', totalPitches: 3 });
  });

  it('lets explicit targets win over derived values', () => {
    expect(resolveClimbingTargets({ exercises, climbingTargets: { maxGrade: '5.12a', totalPitches: 8 } }))
      .toEqual({ maxGrade: '5.12a', totalPitches: 8 });
  });

  it('ignores non-climbing entries', () => {
    const mixed = [...exercises, { id: 'x', name: 'Pull-Up', category: 'strength' } as Exercise];
    expect(resolveClimbingTargets({ exercises: mixed }).totalPitches).toBe(3);
  });
});

describe('sectionLabels', () => {
  it('renames sections for outdoor climbing only', () => {
    expect(sectionLabels('outdoor-climbing')).toEqual({ warmup: 'Approach', exercises: 'Pitches', cooldown: 'Descent' });
    expect(sectionLabels('climbing')).toEqual({ warmup: 'Warm-Up', exercises: 'Main Work', cooldown: 'Cool-Down' });
    expect(sectionLabels(undefined).exercises).toBe('Main Work');
  });
});

describe('ascent styles', () => {
  it('offers follow on roped disciplines but not boulders', () => {
    expect(ascentStylesFor('sport').map(s => s.value)).toEqual(['flash', 'redpoint', 'follow', 'attempt']);
    expect(ascentStylesFor('trad').map(s => s.value)).toContain('follow');
    expect(ascentStylesFor('ice-mixed').map(s => s.value)).toContain('follow');
    expect(ascentStylesFor('boulder').map(s => s.value)).toEqual(['flash', 'redpoint', 'attempt']);
    expect(ascentStylesFor(undefined).map(s => s.value)).toContain('follow');
  });

  it('labels ascents in past tense and returns undefined when unset', () => {
    expect(ascentStyleLabel('redpoint')).toBe('Redpointed');
    expect(ascentStyleLabel(undefined)).toBeUndefined();
  });
});

describe('climbStyleLabel', () => {
  it('labels all styles and falls back for unset', () => {
    expect(climbStyleLabel('ice-mixed')).toBe('Ice/Mixed');
    expect(climbStyleLabel(undefined)).toBe('Climb');
  });
});
