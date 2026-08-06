import { addDays, format, parseISO, startOfISOWeek } from 'date-fns';
import type { TrainingBlock, WeeklyTargets } from '../../types/blocks';
import { validateBlock } from './validate';

// ─── Training cycles ──────────────────────────────────────────────────────────
// The periodization rhythm the calendar could never express: N weeks of work
// followed by one easier week, repeated. src/lib/recurrence/ is deliberately
// not involved — its INTERVAL is a uniform stride, which cannot alternate.
//
// A cycle is not a stored entity. It expands, here, into ordinary
// TrainingBlocks: contiguous, Monday-aligned, non-overlapping, exactly the
// rows the DB already enforces. Nothing downstream needs to know a block
// came from a cycle rather than from the single-block editor.

export const DEFAULT_WEEKS_ON = 3;
export const DEFAULT_WEEKS_OFF = 1;
export const DEFAULT_CYCLES = 4;
/** Recovery weeks carry reduced volume, not zero — a deload, not a layoff. */
export const DEFAULT_RECOVERY_SCALE = 0.5;

/** Matches the batch cap in api/_lib/trainingBlocks.ts. */
export const MAX_CYCLE_BLOCKS = 24;

export interface CycleSpec {
  /** Any date — snapped to the ISO Monday that contains it. */
  startDate: string;
  weeksOn: number;
  /** 0 emits build blocks only. */
  weeksOff: number;
  /** Repetitions of the on/off pair. */
  cycles: number;
  namePrefix: string;
  intent?: string;
  objectiveId?: string;
  weeklyTargets: WeeklyTargets;
  /** Multiplier applied to the recovery block's targets. */
  recoveryScale: number;
}

export class CycleSpecError extends Error {}

export const DEFAULT_CYCLE_SPEC: Omit<CycleSpec, 'startDate' | 'namePrefix'> = {
  weeksOn: DEFAULT_WEEKS_ON,
  weeksOff: DEFAULT_WEEKS_OFF,
  cycles: DEFAULT_CYCLES,
  weeklyTargets: {},
  recoveryScale: DEFAULT_RECOVERY_SCALE,
};

/** Total weeks a spec spans. */
export function cycleTotalWeeks(spec: Pick<CycleSpec, 'weeksOn' | 'weeksOff' | 'cycles'>): number {
  return (spec.weeksOn + spec.weeksOff) * spec.cycles;
}

/** Blocks a spec will emit — the count the batch cap is checked against. */
export function cycleBlockCount(spec: Pick<CycleSpec, 'weeksOff' | 'cycles'>): number {
  return spec.cycles * (spec.weeksOff > 0 ? 2 : 1);
}

/**
 * Scale every target's magnitude, leaving units untouched.
 *
 * Scaling within a unit is not the cross-unit conversion the repo refuses
 * (see the note at the top of src/types/blocks.ts): "3000 ft" scaled by 0.5
 * is "1500 ft", never "457 m". Values round to whole numbers because every
 * target is a count, a minute, or a coarse distance — a 0.5-session target
 * would read as noise.
 */
export function scaleTargets(targets: WeeklyTargets, factor: number): WeeklyTargets {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new CycleSpecError('Recovery scale must be a non-negative number');
  }
  const scale = (n: number) => Math.max(0, Math.round(n * factor));
  const out: WeeklyTargets = {};
  if (targets.cardioMinutes !== undefined) out.cardioMinutes = scale(targets.cardioMinutes);
  if (targets.strengthSessions !== undefined) out.strengthSessions = scale(targets.strengthSessions);
  if (targets.climbingSessions !== undefined) out.climbingSessions = scale(targets.climbingSessions);
  // Not scaled: a "long session" target is a threshold ("count sessions of 240+
  // minutes"), not a volume. Halving it would count MORE sessions in the
  // recovery week, which is backwards.
  if (targets.longSessionMinutes !== undefined) out.longSessionMinutes = targets.longSessionMinutes;
  if (targets.vert !== undefined) out.vert = { value: scale(targets.vert.value), unit: targets.vert.unit };
  if (targets.distance !== undefined) {
    out.distance = { value: scale(targets.distance.value), unit: targets.distance.unit };
  }
  return out;
}

function assertSpec(spec: CycleSpec): void {
  if (!spec.namePrefix.trim()) throw new CycleSpecError('A cycle needs a name');
  if (!Number.isInteger(spec.weeksOn) || spec.weeksOn < 1) {
    throw new CycleSpecError('Weeks on must be a whole number of at least 1');
  }
  if (!Number.isInteger(spec.weeksOff) || spec.weeksOff < 0) {
    throw new CycleSpecError('Weeks off must be a whole number of 0 or more');
  }
  if (!Number.isInteger(spec.cycles) || spec.cycles < 1) {
    throw new CycleSpecError('A cycle must repeat at least once');
  }
  if (cycleBlockCount(spec) > MAX_CYCLE_BLOCKS) {
    throw new CycleSpecError(`That would create more than ${MAX_CYCLE_BLOCKS} blocks — shorten the plan`);
  }
}

/**
 * Expand a spec into contiguous blocks: build, recovery, build, recovery…
 *
 * Every block is run through validateBlock before it is returned, so a spec
 * that would produce an over-long or misaligned block fails here with a
 * readable message rather than as a raw SQLSTATE from the CHECK constraint.
 */
export function generateCycle(spec: CycleSpec): Omit<TrainingBlock, 'id'>[] {
  assertSpec(spec);

  const prefix = spec.namePrefix.trim();
  const intent = spec.intent?.trim() ?? '';
  const start = startOfISOWeek(parseISO(spec.startDate));
  const recoveryTargets = scaleTargets(spec.weeklyTargets, spec.recoveryScale);

  const blocks: Omit<TrainingBlock, 'id'>[] = [];
  let weekCursor = 0;

  const push = (label: string, index: number, weeks: number, targets: WeeklyTargets, phase: 'build' | 'recovery') => {
    blocks.push({
      name: `${prefix} · ${label} ${index}`,
      intent,
      phase,
      objectiveId: spec.objectiveId || undefined,
      startDate: format(addDays(start, weekCursor * 7), 'yyyy-MM-dd'),
      endDateExclusive: format(addDays(start, (weekCursor + weeks) * 7), 'yyyy-MM-dd'),
      weeklyTargets: targets,
    });
    weekCursor += weeks;
  };

  for (let i = 1; i <= spec.cycles; i++) {
    push('Build', i, spec.weeksOn, spec.weeklyTargets, 'build');
    if (spec.weeksOff > 0) push('Recovery', i, spec.weeksOff, recoveryTargets, 'recovery');
  }

  blocks.forEach(validateBlock);
  return blocks;
}

/**
 * The first existing block a generated set would collide with, or null.
 *
 * A courtesy pre-check only: the DB exclusion constraint is the real guard,
 * and a read-then-write check in application code would race. This exists so
 * the editor can name the conflicting block instead of surfacing a bare 409.
 */
export function overlapsExisting(
  generated: Pick<TrainingBlock, 'startDate' | 'endDateExclusive'>[],
  existing: TrainingBlock[],
): TrainingBlock | null {
  for (const block of existing) {
    for (const candidate of generated) {
      // Half-open ranges overlap iff each starts before the other ends.
      if (candidate.startDate < block.endDateExclusive && block.startDate < candidate.endDateExclusive) {
        return block;
      }
    }
  }
  return null;
}

/** True for the error kind the editor should surface verbatim. */
export function isCycleSpecError(err: unknown): err is CycleSpecError {
  return err instanceof CycleSpecError;
}
