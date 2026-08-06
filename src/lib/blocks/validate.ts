import { getISODay, parseISO } from 'date-fns';
import type { TrainingBlock } from '../../types/blocks';
import { blockWeeks } from './period';
import { parseWeeklyTargets, TargetValidationError } from './targets';

// Mirrors the CHECK constraints in phase19_training_blocks.sql. The DB is the
// real guard — this exists so the editor and the API can reject with a
// readable message instead of surfacing a raw SQLSTATE 23514.

export class BlockValidationError extends Error {}

const MAX_WEEKS = 52;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireMonday(label: string, date: string): void {
  if (!ISO_DATE.test(date)) {
    throw new BlockValidationError(`${label} must be a YYYY-MM-DD date`);
  }
  const parsed = parseISO(date);
  if (Number.isNaN(parsed.getTime())) {
    throw new BlockValidationError(`${label} is not a valid date`);
  }
  if (getISODay(parsed) !== 1) {
    throw new BlockValidationError(`${label} must be a Monday`);
  }
}

/**
 * Validate a block's own fields. Overlap is NOT checked here — that is the
 * DB exclusion constraint's job, and a read-then-write check in application
 * code would race under concurrent writes.
 */
export function validateBlock(block: Omit<TrainingBlock, 'id'>): void {
  if (!block.name.trim()) {
    throw new BlockValidationError('A block needs a name');
  }
  requireMonday('Start date', block.startDate);
  requireMonday('End date', block.endDateExclusive);
  if (block.endDateExclusive <= block.startDate) {
    throw new BlockValidationError('A block must end after it starts');
  }
  const weeks = blockWeeks(block);
  if (weeks > MAX_WEEKS) {
    throw new BlockValidationError(`A block cannot be longer than ${MAX_WEEKS} weeks (got ${weeks})`);
  }
  parseWeeklyTargets(block.weeklyTargets);
}

/** True for the two error kinds an API layer should turn into a 400. */
export function isValidationError(err: unknown): err is Error {
  return err instanceof BlockValidationError || err instanceof TargetValidationError;
}
