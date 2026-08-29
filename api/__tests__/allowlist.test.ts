import { describe, it, expect } from 'vitest';
import {
  pickAllowed,
  EVENT_INSERT_COLUMNS,
  EVENT_PATCH_COLUMNS,
  DEFINITION_INSERT_COLUMNS,
  DEFINITION_PATCH_COLUMNS,
  MEAL_INSERT_COLUMNS,
  MEAL_PATCH_COLUMNS,
  MEAL_FAVORITE_COLUMNS,
  BLOCK_INSERT_COLUMNS,
  BLOCK_PATCH_COLUMNS,
  OBJECTIVE_INSERT_COLUMNS,
  OBJECTIVE_PATCH_COLUMNS,
  WORKOUT_TEMPLATE_COLUMNS,
  ANALYTICS_TILE_COLUMNS,
} from '../_lib/allowlist';
import { eventToRow, eventFieldsToRow } from '../../src/lib/schedule/mapping';
import { definitionFieldsToRow } from '../../src/lib/schedule/definitions';
import { templateToRow } from '../../src/lib/schedule/templates';
import { favoriteToRow, mealFieldsToRow, mealToRow } from '../../src/lib/nutrition/mapping';
import { blockToRow, blockFieldsToRow, objectiveToRow, objectiveFieldsToRow } from '../../src/lib/blocks/mapping';
import type { ExerciseDefinition, WorkoutTemplate } from '../../src/types/workout';
import type { Meal } from '../../src/types/nutrition';
import type { Objective, TrainingBlock } from '../../src/types/blocks';

// The allowlists must accept everything the client mapping layer emits —
// these tests pin the two together so they cannot drift silently.

const FULL_EVENT: Parameters<typeof eventToRow>[0] = {
  id: 'evt-1',
  type: 'weights',
  title: 'Upper Body',
  subtitle: 'Push focus',
  date: '2026-07-24',
  startTime: '07:00',
  endTime: '08:00',
  estimatedDuration: 60,
  description: 'desc',
  warmup: [],
  exercises: [],
  cooldown: [],
  difficulty: 3,
  location: 'Gym',
  coverImageUrl: 'https://example.com/x.jpg',
  cardioTargets: { distance: '5k' },
  climbingTargets: { totalPitches: 3 },
  tags: ['push'],
  equipment: ['barbell'],
  isCompleted: false,
  isRecurring: true,
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
  recurringPattern: { frequency: 'weekly', daysOfWeek: [1], endDate: '2026-12-31' },
  templateId: 'wt-1',
  scoringType: 'for-time',
  timeCapMinutes: 20,
};

const FULL_TEMPLATE: WorkoutTemplate = {
  id: 'wt-1',
  title: 'MURPH',
  type: 'weights',
  scoringType: 'for-time',
  timeCapMinutes: 60,
  estimatedDuration: 60,
  difficulty: 5,
  description: 'The hero WOD',
  warmup: [],
  exercises: [],
  cooldown: [],
  location: 'Gym',
  tags: ['hero'],
  equipment: ['pull-up bar'],
  cardioTargets: { distance: '2 mi' },
  climbingTargets: { totalPitches: 0 },
  archivedAt: undefined,
};

const FULL_DEFINITION_FIELDS: Partial<ExerciseDefinition> = {
  canonicalName: 'Bench Press',
  aliases: ['BP'],
  category: 'strength',
  muscleGroups: ['chest'],
  equipment: ['barbell'],
  imageUrl: null,
  techniqueNotes: 'notes',
  isUnilateral: false,
  defaultSets: 3,
  defaultReps: '8',
  defaultDuration: null,
  defaultWeight: '135 lb',
  defaultRest: '2 min',
  archivedAt: null,
  // DB rows carry SQL NULLs where the client type says `?: string` — the
  // allowlist must accept them, so the fixture keeps the nulls via unknown.
} as unknown as Partial<ExerciseDefinition>;

const FULL_MEAL: Meal = {
  id: 'meal-1',
  title: 'Chicken burrito',
  date: '2026-08-06',
  time: '12:30 PM',
  mealType: 'lunch',
  calories: 700,
  proteinG: 42,
  carbsG: 55,
  fiberG: 8,
  sugarG: 6,
  fatTotalG: 24,
  fatSaturatedG: 9,
  fatTransG: 0.5,
  alcoholG: 14,
  notes: 'Extra rice',
};

const FULL_BLOCK: Omit<TrainingBlock, 'id'> = {
  objectiveId: 'obj-1',
  name: 'Fall Aerobic Foundation',
  intent: 'Build the base',
  phase: 'base',
  startDate: '2026-03-02',
  endDateExclusive: '2026-04-27',
  weeklyTargets: { cardioMinutes: 420, vert: { value: 8000, unit: 'ft' } },
};

const FULL_OBJECTIVE: Omit<Objective, 'id'> = {
  name: 'Liberty Ridge',
  targetDate: '2027-06-15',
  discipline: 'alpine',
  notes: 'Rainier north side',
  status: 'active',
};

describe('pickAllowed', () => {
  it('splits allowed and rejected keys', () => {
    const { picked, rejected } = pickAllowed(
      { title: 'x', user_id: 'someone-else', is_template_source: true },
      EVENT_INSERT_COLUMNS,
    );
    expect(picked).toEqual({ title: 'x' });
    expect(rejected.sort()).toEqual(['is_template_source', 'user_id']);
  });

  it('never allows identity or server-managed columns', () => {
    for (const set of [
      EVENT_INSERT_COLUMNS, EVENT_PATCH_COLUMNS,
      DEFINITION_INSERT_COLUMNS, DEFINITION_PATCH_COLUMNS,
      MEAL_INSERT_COLUMNS, MEAL_PATCH_COLUMNS, MEAL_FAVORITE_COLUMNS,
      BLOCK_INSERT_COLUMNS, BLOCK_PATCH_COLUMNS,
      OBJECTIVE_INSERT_COLUMNS, OBJECTIVE_PATCH_COLUMNS,
      WORKOUT_TEMPLATE_COLUMNS, ANALYTICS_TILE_COLUMNS,
    ]) {
      expect(set.has('user_id')).toBe(false);
      expect(set.has('created_at')).toBe(false);
      expect(set.has('updated_at')).toBe(false);
    }
    expect(EVENT_PATCH_COLUMNS.has('id')).toBe(false);
    expect(DEFINITION_PATCH_COLUMNS.has('id')).toBe(false);
    expect(MEAL_PATCH_COLUMNS.has('id')).toBe(false);
    // Block and objective ids are server-generated UUIDs, never client-supplied.
    expect(BLOCK_INSERT_COLUMNS.has('id')).toBe(false);
    expect(OBJECTIVE_INSERT_COLUMNS.has('id')).toBe(false);
  });
});

describe('client/server mirror', () => {
  it('accepts every column eventToRow emits', () => {
    const row = eventToRow(FULL_EVENT);
    const { rejected } = pickAllowed(row as unknown as Record<string, unknown>, EVENT_INSERT_COLUMNS);
    expect(rejected).toEqual([]);
  });

  it('accepts every column eventFieldsToRow emits for a full patch', () => {
    const { id: _id, isCompleted: _c, ...fields } = FULL_EVENT;
    const row = eventFieldsToRow(fields);
    const { rejected } = pickAllowed(row as Record<string, unknown>, EVENT_PATCH_COLUMNS);
    expect(rejected).toEqual([]);
  });

  it('accepts every column mealToRow emits', () => {
    const row = mealToRow(FULL_MEAL);
    const { rejected } = pickAllowed(row as unknown as Record<string, unknown>, MEAL_INSERT_COLUMNS);
    expect(rejected).toEqual([]);
  });

  it('accepts every column mealFieldsToRow emits for a full patch', () => {
    const { id: _id, ...fields } = FULL_MEAL;
    const row = mealFieldsToRow(fields);
    const { rejected } = pickAllowed(row as Record<string, unknown>, MEAL_PATCH_COLUMNS);
    expect(rejected).toEqual([]);
  });

  it('accepts every column favoriteToRow emits', () => {
    const { date: _d, time: _t, ...favorite } = FULL_MEAL;
    const row = favoriteToRow(favorite);
    const { rejected } = pickAllowed(row as unknown as Record<string, unknown>, MEAL_FAVORITE_COLUMNS);
    expect(rejected).toEqual([]);
  });

  it('accepts every column templateToRow emits', () => {
    const row = templateToRow(FULL_TEMPLATE);
    const { rejected } = pickAllowed(row as unknown as Record<string, unknown>, WORKOUT_TEMPLATE_COLUMNS);
    expect(rejected).toEqual([]);
  });

  // The analytics tile mapper (src/lib/analytics/tiles.ts) lands with the
  // engine PR; until then this pins the exact column set the handler
  // accepts, so a drive-by addition here fails loudly.
  it('pins the analytics tile columns', () => {
    expect([...ANALYTICS_TILE_COLUMNS].sort()).toEqual(['h', 'id', 'spec', 'w', 'x', 'y']);
  });

  it('accepts every column definitionFieldsToRow emits', () => {
    const row = definitionFieldsToRow(FULL_DEFINITION_FIELDS);
    const { rejected: insertRejected } = pickAllowed(row, DEFINITION_INSERT_COLUMNS);
    const { rejected: patchRejected } = pickAllowed(row, DEFINITION_PATCH_COLUMNS);
    expect(insertRejected).toEqual([]);
    expect(patchRejected).toEqual([]);
  });

  it('accepts every column blockToRow / blockFieldsToRow emits', () => {
    const { rejected: insertRejected } = pickAllowed(
      blockToRow(FULL_BLOCK) as unknown as Record<string, unknown>,
      BLOCK_INSERT_COLUMNS,
    );
    const { rejected: patchRejected } = pickAllowed(
      blockFieldsToRow(FULL_BLOCK) as Record<string, unknown>,
      BLOCK_PATCH_COLUMNS,
    );
    expect(insertRejected).toEqual([]);
    expect(patchRejected).toEqual([]);
  });

  it('accepts every column objectiveToRow / objectiveFieldsToRow emits', () => {
    const { rejected: insertRejected } = pickAllowed(
      objectiveToRow(FULL_OBJECTIVE) as unknown as Record<string, unknown>,
      OBJECTIVE_INSERT_COLUMNS,
    );
    const { rejected: patchRejected } = pickAllowed(
      objectiveFieldsToRow(FULL_OBJECTIVE) as Record<string, unknown>,
      OBJECTIVE_PATCH_COLUMNS,
    );
    expect(insertRejected).toEqual([]);
    expect(patchRejected).toEqual([]);
  });
});
