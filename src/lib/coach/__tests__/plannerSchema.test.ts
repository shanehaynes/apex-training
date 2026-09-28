import { describe, it, expect } from 'vitest';
import { plannerToolSchemas, updateBlockDraftSchema } from '../schemas';
import { BLOCK_PHASES } from '../../../types/blocks';
import { WEEKLY_TARGET_KEYS } from '../../blocks/targets';

// schemas.ts must stay dependency-free (api/chat.ts imports it), so the
// planner's phase enum and target keys are hand-mirrored from the blocks
// module. This is the drift lock, like analyticsSchema.test.ts beside it.

type SchemaObject = { properties?: Record<string, SchemaObject>; items?: SchemaObject; enum?: string[]; required?: string[] };

const input = updateBlockDraftSchema.input_schema as SchemaObject;
const item = input.properties!.blocks.items!;

const SNAKE: Record<string, string> = {
  cardioMinutes: 'cardio_minutes', vert: 'vert', distance: 'distance',
  strengthSessions: 'strength_sessions', climbingSessions: 'climbing_sessions', longSessionMinutes: 'long_session_minutes',
};

describe('update_block_draft schema mirrors the blocks module', () => {
  it('is the planner\'s one write, named for the client settle and the coach-tool handler', () => {
    expect(plannerToolSchemas().map(t => t.name)).toEqual(['update_block_draft']);
    expect(input.required).toEqual(['blocks']);
    expect(item.required).toEqual(['name', 'start_date', 'end_date']);
  });

  it('phase enum equals BLOCK_PHASES', () => {
    expect(item.properties!.phase.enum).toEqual([...BLOCK_PHASES]);
  });

  it('weekly_targets keys are exactly WEEKLY_TARGET_KEYS in snake_case, with the units the targets module accepts', () => {
    const targets = item.properties!.weekly_targets.properties!;
    expect(Object.keys(targets).sort()).toEqual(WEEKLY_TARGET_KEYS.map(k => SNAKE[k]).sort());
    expect(targets.vert.properties!.unit.enum).toEqual(['ft', 'm']);
    expect(targets.distance.properties!.unit.enum).toEqual(['mi', 'km']);
    expect(targets.vert.required).toEqual(['value', 'unit']);
  });

  it('says what the reducer enforces and that only the user applies', () => {
    for (const phrase of ['WHOLE list', 'a Monday', 'Sunday', 'contiguous', 'overlaps', 'this week\'s Monday', '1–24 blocks', 'exactly one item', 'presses Apply']) {
      expect(updateBlockDraftSchema.description, phrase).toContain(phrase);
    }
  });
});
