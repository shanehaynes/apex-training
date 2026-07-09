import { describe, it, expect } from 'vitest';
import {
  buildAliasIndex,
  canonicalNameOf,
  canonicalizeLogNames,
  entryFromDefinition,
  expandNamesWithAliases,
  hasPerSideCount,
  resolveExercise,
  resolveEventExercises,
  rowToDefinition,
  uniqueEntryId,
} from '../definitions';
import type { Exercise, ExerciseDefinition, WorkoutEvent } from '../../../types/workout';
import type { SetLogRow } from '../../db/types';

function makeDefinition(overrides: Partial<ExerciseDefinition> & Pick<ExerciseDefinition, 'id' | 'canonicalName'>): ExerciseDefinition {
  return {
    aliases: [],
    category: 'strength',
    muscleGroups: [],
    equipment: [],
    isUnilateral: false,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<Exercise> & Pick<Exercise, 'id' | 'name'>): Exercise {
  return { category: 'strength', ...overrides };
}

const pistol = makeDefinition({
  id: 'pistol-squat',
  canonicalName: 'Pistol Squat',
  category: 'skill',
  muscleGroups: ['quads', 'glutes'],
  imageUrl: 'https://img/pistol.png',
  techniqueNotes: 'Heel flat; counterbalance with arms.',
});
const defs = new Map([[pistol.id, pistol]]);

describe('resolveExercise', () => {
  it('resolves definition-tier fields and keeps the prescription', () => {
    const entry = makeEntry({
      id: 'ex-1',
      definitionId: 'pistol-squat',
      name: 'Pistol Squats',       // stale snapshot
      category: 'strength',        // stale snapshot
      sets: 3,
      reps: '5 each leg',
      weight: '10lb',
      notes: 'Last set AMRAP today',
    });
    const resolved = resolveExercise(entry, defs);
    expect(resolved.name).toBe('Pistol Squat');
    expect(resolved.category).toBe('skill');
    expect(resolved.muscleGroups).toEqual(['quads', 'glutes']);
    expect(resolved.imageUrl).toBe('https://img/pistol.png');
    expect(resolved.techniqueNotes).toBe('Heel flat; counterbalance with arms.');
    // Prescription and instance notes are the entry's own, untouched.
    expect(resolved.sets).toBe(3);
    expect(resolved.reps).toBe('5 each leg');
    expect(resolved.weight).toBe('10lb');
    expect(resolved.notes).toBe('Last set AMRAP today');
  });

  it('returns the entry unchanged without a definitionId (pre-migration / ad-hoc)', () => {
    const entry = makeEntry({ id: 'ex-2', name: 'Mystery Movement' });
    expect(resolveExercise(entry, defs)).toBe(entry);
  });

  it('falls back to snapshots when the definition is missing', () => {
    const entry = makeEntry({ id: 'ex-3', definitionId: 'deleted-def', name: 'Old Name', imageUrl: 'snap.png' });
    const resolved = resolveExercise(entry, defs);
    expect(resolved).toBe(entry);
  });

  it('keeps snapshot muscleGroups/imageUrl when the definition has none', () => {
    const bare = makeDefinition({ id: 'bare', canonicalName: 'Bare' });
    const entry = makeEntry({
      id: 'ex-4', definitionId: 'bare', name: 'Bare', muscleGroups: ['calves'], imageUrl: 'snap.png',
    });
    const resolved = resolveExercise(entry, new Map([['bare', bare]]));
    expect(resolved.muscleGroups).toEqual(['calves']);
    expect(resolved.imageUrl).toBe('snap.png');
  });
});

describe('resolveEventExercises', () => {
  const event: WorkoutEvent = {
    id: 'evt', type: 'weights', title: 'Legs', date: '2026-07-08',
    estimatedDuration: 45, description: '', difficulty: 3, tags: [],
    isCompleted: false, isRecurring: false,
    warmup: [makeEntry({ id: 'w1', definitionId: 'pistol-squat', name: 'stale' })],
    exercises: [makeEntry({ id: 'e1', definitionId: 'pistol-squat', name: 'stale' })],
  };

  it('resolves every section', () => {
    const resolved = resolveEventExercises(event, defs);
    expect(resolved.warmup?.[0].name).toBe('Pistol Squat');
    expect(resolved.exercises[0].name).toBe('Pistol Squat');
    expect(resolved.cooldown).toBeUndefined();
  });

  it('is a no-op with an empty library', () => {
    expect(resolveEventExercises(event, new Map())).toBe(event);
  });
});

describe('alias index', () => {
  const index = buildAliasIndex([
    { canonicalName: 'Hammer Curl', aliases: ['Hammer Curls'] },
    { canonicalName: 'Weighted Dip', aliases: [] },
  ]);

  it('maps any spelling (case/whitespace-insensitive) to the canonical name', () => {
    expect(canonicalNameOf('hammer  curls', index)).toBe('Hammer Curl');
    expect(canonicalNameOf('HAMMER CURL', index)).toBe('Hammer Curl');
  });

  it('passes unknown names through unchanged', () => {
    expect(canonicalNameOf('Zercher Squat', index)).toBe('Zercher Squat');
  });

  it('expands names to every known spelling for the history fetch', () => {
    expect(expandNamesWithAliases(['Hammer Curl', 'Zercher Squat'], index).sort()).toEqual(
      ['Hammer Curl', 'Hammer Curls', 'Zercher Squat'],
    );
  });

  it('unifies pre-rename log rows under the canonical name, in memory only', () => {
    const rows = [
      { exercise_name: 'Hammer Curls' },
      { exercise_name: 'Hammer Curl' },
      { exercise_name: 'Zercher Squat' },
    ] as SetLogRow[];
    const out = canonicalizeLogNames(rows, index);
    expect(out.map(r => r.exercise_name)).toEqual(['Hammer Curl', 'Hammer Curl', 'Zercher Squat']);
    // Source rows are never mutated — append-only history stays pristine.
    expect(rows[0].exercise_name).toBe('Hammer Curls');
  });
});

describe('entry authoring helpers', () => {
  const dip = makeDefinition({
    id: 'weighted-dip',
    canonicalName: 'Weighted Dip',
    category: 'strength',
    defaultSets: 3,
    defaultReps: '8',
    defaultWeight: '25lb',
    defaultRest: '2 min',
  });

  it('entryFromDefinition prefills prescription gaps from defaults, overrides win', () => {
    const entry = entryFromDefinition(dip, 'weighted-dip-2', { reps: '5', notes: 'AMRAP last set' });
    expect(entry).toMatchObject({
      id: 'weighted-dip-2',
      definitionId: 'weighted-dip',
      name: 'Weighted Dip',
      category: 'strength',
      sets: 3,            // default
      reps: '5',          // override wins
      weight: '25lb',     // default
      restPeriod: '2 min',
      notes: 'AMRAP last set',
    });
  });

  it('uniqueEntryId never collides with existing ids', () => {
    expect(uniqueEntryId('weighted-dip', [])).toBe('weighted-dip');
    expect(uniqueEntryId('weighted-dip', ['weighted-dip'])).toBe('weighted-dip-2');
    expect(uniqueEntryId('weighted-dip', ['weighted-dip', 'weighted-dip-2'])).toBe('weighted-dip-3');
  });

  it('hasPerSideCount recognizes the per-side conventions', () => {
    expect(hasPerSideCount('5 each leg')).toBe(true);
    expect(hasPerSideCount('30s per side')).toBe(true);
    expect(hasPerSideCount('10 total')).toBe(true);
    expect(hasPerSideCount('5')).toBe(false);
    expect(hasPerSideCount(undefined)).toBe(false);
  });
});

describe('rowToDefinition', () => {
  it('maps snake_case columns and nulls to camelCase optionals', () => {
    const def = rowToDefinition({
      id: 'weighted-dip', canonical_name: 'Weighted Dip', aliases: ['Weighted Dips'],
      category: 'strength', muscle_groups: ['chest', 'triceps'], equipment: ['dip belt'],
      image_url: null, technique_notes: 'Slight forward lean.', is_unilateral: false,
      default_sets: 3, default_reps: '8', default_duration: null, default_weight: '25lb',
      default_rest: '2 min', archived_at: null,
      created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-08T00:00:00Z',
    });
    expect(def.canonicalName).toBe('Weighted Dip');
    expect(def.aliases).toEqual(['Weighted Dips']);
    expect(def.imageUrl).toBeUndefined();
    expect(def.techniqueNotes).toBe('Slight forward lean.');
    expect(def.defaultSets).toBe(3);
    expect(def.archivedAt).toBeUndefined();
  });
});
