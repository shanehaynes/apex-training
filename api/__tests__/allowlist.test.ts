import { describe, it, expect } from 'vitest';
import {
  pickAllowed,
  EVENT_INSERT_COLUMNS,
  EVENT_PATCH_COLUMNS,
  DEFINITION_INSERT_COLUMNS,
  DEFINITION_PATCH_COLUMNS,
} from '../_lib/allowlist';
import { eventToRow, eventFieldsToRow } from '../../src/lib/schedule/mapping';
import { definitionFieldsToRow } from '../../src/lib/schedule/definitions';
import type { ExerciseDefinition } from '../../src/types/workout';

// The allowlists must accept everything the client mapping layer emits —
// these tests pin the two together so they cannot drift silently.

const FULL_EVENT: Parameters<typeof eventToRow>[0] = {
  id: 'evt-1',
  type: 'strength',
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
  climbingTargets: { pitches: 3 },
  tags: ['push'],
  equipment: ['barbell'],
  isCompleted: false,
  isRecurring: true,
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
  recurringPattern: { frequency: 'weekly', daysOfWeek: [1], endDate: '2026-12-31' },
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
} as Partial<ExerciseDefinition>;

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
    for (const set of [EVENT_INSERT_COLUMNS, EVENT_PATCH_COLUMNS, DEFINITION_INSERT_COLUMNS, DEFINITION_PATCH_COLUMNS]) {
      expect(set.has('user_id')).toBe(false);
      expect(set.has('created_at')).toBe(false);
      expect(set.has('updated_at')).toBe(false);
    }
    expect(EVENT_PATCH_COLUMNS.has('id')).toBe(false);
    expect(DEFINITION_PATCH_COLUMNS.has('id')).toBe(false);
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

  it('accepts every column definitionFieldsToRow emits', () => {
    const row = definitionFieldsToRow(FULL_DEFINITION_FIELDS);
    const { rejected: insertRejected } = pickAllowed(row, DEFINITION_INSERT_COLUMNS);
    const { rejected: patchRejected } = pickAllowed(row, DEFINITION_PATCH_COLUMNS);
    expect(insertRejected).toEqual([]);
    expect(patchRejected).toEqual([]);
  });
});
