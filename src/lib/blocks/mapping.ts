import type { ObjectiveRow, TrainingBlockRow } from '../db/types';
import type {
  BlockPhase,
  Objective,
  ObjectiveDiscipline,
  ObjectiveStatus,
  TrainingBlock,
} from '../../types/blocks';
import { parseWeeklyTargets } from './targets.js';

// ─── Row ↔ domain mapping (phase 19) ─────────────────────────────────────────
// Pure converters, mirroring src/lib/schedule/mapping.ts. The camelCase ↔
// snake_case knowledge lives here exactly once.

type BlockRowInsert = Omit<TrainingBlockRow, 'id' | 'created_at' | 'updated_at'>;
type ObjectiveRowInsert = Omit<ObjectiveRow, 'id' | 'created_at' | 'updated_at'>;

export function rowToBlock(row: TrainingBlockRow): TrainingBlock {
  return {
    id:               row.id,
    objectiveId:      row.objective_id ?? undefined,
    name:             row.name,
    intent:           row.intent,
    phase:            (row.phase ?? undefined) as BlockPhase | undefined,
    startDate:        row.start_date,
    endDateExclusive: row.end_date_exclusive,
    // Stored rows are already validated on the way in, but a hand-edited row
    // must not crash the whole calendar — fall back to no targets.
    weeklyTargets:    safeTargets(row.weekly_targets),
  };
}

function safeTargets(raw: unknown) {
  try {
    return parseWeeklyTargets(raw);
  } catch {
    return {};
  }
}

export function blockToRow(block: Omit<TrainingBlock, 'id'>): BlockRowInsert {
  return {
    objective_id:       block.objectiveId ?? null,
    name:               block.name,
    intent:             block.intent,
    phase:              block.phase ?? null,
    start_date:         block.startDate,
    end_date_exclusive: block.endDateExclusive,
    weekly_targets:     block.weeklyTargets,
  };
}

/** Only the columns for fields actually present — for PATCH bodies. */
export function blockFieldsToRow(fields: Partial<Omit<TrainingBlock, 'id'>>): Partial<BlockRowInsert> {
  const row: Partial<BlockRowInsert> = {};
  if (fields.objectiveId !== undefined)      row.objective_id = fields.objectiveId ?? null;
  if (fields.name !== undefined)             row.name = fields.name;
  if (fields.intent !== undefined)           row.intent = fields.intent;
  if (fields.phase !== undefined)            row.phase = fields.phase ?? null;
  if (fields.startDate !== undefined)        row.start_date = fields.startDate;
  if (fields.endDateExclusive !== undefined) row.end_date_exclusive = fields.endDateExclusive;
  if (fields.weeklyTargets !== undefined)    row.weekly_targets = fields.weeklyTargets;
  return row;
}

export function rowToObjective(row: ObjectiveRow): Objective {
  return {
    id:         row.id,
    name:       row.name,
    targetDate: row.target_date ?? undefined,
    discipline: (row.discipline ?? undefined) as ObjectiveDiscipline | undefined,
    notes:      row.notes,
    status:     row.status as ObjectiveStatus,
  };
}

export function objectiveToRow(objective: Omit<Objective, 'id'>): ObjectiveRowInsert {
  return {
    name:                  objective.name,
    target_date:           objective.targetDate ?? null,
    discipline:            objective.discipline ?? null,
    notes:                 objective.notes,
    required_capabilities: [],
    status:                objective.status,
  };
}

export function objectiveFieldsToRow(
  fields: Partial<Omit<Objective, 'id'>>,
): Partial<ObjectiveRowInsert> {
  const row: Partial<ObjectiveRowInsert> = {};
  if (fields.name !== undefined)       row.name = fields.name;
  if (fields.targetDate !== undefined) row.target_date = fields.targetDate ?? null;
  if (fields.discipline !== undefined) row.discipline = fields.discipline ?? null;
  if (fields.notes !== undefined)      row.notes = fields.notes;
  if (fields.status !== undefined)     row.status = fields.status;
  return row;
}
