import { parseISO } from 'date-fns';
import { ToolInputError, type McpToolDef } from '../protocol.js';
import { optionalBoolean, optionalEnum, requireDate, requireString } from '../args.js';
import { fetchExpandedSchedule, todayIso } from '../data.js';
import { fetchPeriodInputs } from '../../reviewData.js';
import type { ObjectiveRow, TrainingBlockRow } from '../../../../src/lib/db/types.js';
import type { Objective, TrainingBlock } from '../../../../src/types/blocks.js';
import { rowToBlock, rowToObjective } from '../../../../src/lib/blocks/mapping.js';
import { blockCovering, blockPeriod, blockWeeks, currentWeekIndex } from '../../../../src/lib/blocks/period.js';
import { computeBlockProgress } from '../../../../src/lib/blocks/progress.js';
import { describeRecord } from '../../../../src/lib/tracking/records.js';

// Training-block tool: blocks, linked objectives, and target-vs-actual
// attainment. All attainment numbers come from computeBlockProgress — the
// same pre-computed values the coach prompt cites.
//
// W10 widened it for the phone's Blocks screens, all additive: `today` (the
// caller's local date — the server has no user timezone, and a fixture that
// read the clock would drift daily), `block_id` (progress for ANY block, not
// only the one covering today — a detail screen for a past block has no
// other path), `include_objectives` (the full list with ids, which the
// editor's picker needs), plus `id`s and `current_week` on the summaries.

type Admin = Parameters<McpToolDef['run']>[0];

function objectiveSummary(objective: Objective) {
  return {
    id: objective.id,
    name: objective.name,
    discipline: objective.discipline ?? null,
    target_date: objective.targetDate ?? null,
    status: objective.status,
    notes: objective.notes ?? null,
  };
}

function blockSummary(block: TrainingBlock, objectives: Map<string, Objective>, today: Date) {
  const objective = block.objectiveId ? objectives.get(block.objectiveId) ?? null : null;
  return {
    id: block.id,
    name: block.name,
    intent: block.intent,
    phase: block.phase ?? null,
    objective_id: block.objectiveId ?? null,
    start_date: block.startDate,
    end_date_exclusive: block.endDateExclusive,
    weeks: blockWeeks(block),
    /** 1-based, null unless `today` falls inside the block. */
    current_week: currentWeekIndex(block, today),
    weekly_targets: block.weeklyTargets,
    objective: objective ? objectiveSummary(objective) : null,
  };
}

async function progressFor(supabase: Admin, userId: string, block: TrainingBlock, today: Date) {
  const period = blockPeriod(block);
  const [inputs, { occurrences }] = await Promise.all([
    fetchPeriodInputs(supabase, userId, period),
    fetchExpandedSchedule(supabase, userId, block.endDateExclusive),
  ]);
  const plannedEvents = occurrences.filter(
    e => e.date >= block.startDate && e.date < block.endDateExclusive,
  );
  const result = computeBlockProgress({ ...inputs, block, plannedEvents }, today);
  return {
    weeks_total: result.weeksTotal,
    weeks_elapsed: result.weeksElapsed,
    current_week: result.currentWeek,
    to_date: {
      attainment: result.toDate.attainment,
      totals: result.toDate.stats.totals,
    },
    weeks: result.weeks.map(w => ({
      index: w.index,
      start_date: w.startDate,
      is_complete: w.isComplete,
      sessions_completed: w.sessionsCompleted,
      attainment: w.attainment,
    })),
    prs: result.prs.map(pr => ({ ...pr, description: describeRecord(pr) })),
  };
}

export const getTrainingBlocksTool: McpToolDef = {
  name: 'get_training_blocks',
  description:
    'Training blocks (Monday-aligned mesocycles) with their objectives and, for the current block ' +
    '(or the one named by block_id), computed weekly-target attainment (targets vs logged actuals, ' +
    'per week and to date). Numbers are pre-computed — cite them, never recompute.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['current', 'all'], description: 'Default "current".' },
      include_progress: { type: 'boolean', description: 'Compute attainment for the current block (default true).' },
      block_id: { type: 'string', description: 'Compute attainment for this block instead, answered under "block".' },
      include_objectives: { type: 'boolean', description: 'Also list every objective with its id (default false).' },
      today: { type: 'string', description: 'The caller\'s local date, YYYY-MM-DD. Defaults to the server\'s UTC date.' },
    },
  },
  async run(supabase, userId, args) {
    const scope = optionalEnum(args, 'scope', ['current', 'all'] as const, 'current');
    const includeProgress = optionalBoolean(args, 'include_progress', true);
    const includeObjectives = optionalBoolean(args, 'include_objectives', false);
    const blockId = args.block_id === undefined || args.block_id === null ? undefined : requireString(args, 'block_id');
    const today = args.today === undefined || args.today === null ? todayIso() : requireDate(args, 'today');
    const todayDate = parseISO(today);

    const [blocksRes, objectivesRes] = await Promise.all([
      supabase.from('training_blocks').select('*').eq('user_id', userId).order('start_date', { ascending: true }),
      supabase.from('objectives').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
    ]);
    if (blocksRes.error) throw new Error(`training_blocks fetch failed: ${blocksRes.error.message}`);
    if (objectivesRes.error) throw new Error(`objectives fetch failed: ${objectivesRes.error.message}`);

    const blocks = (blocksRes.data as TrainingBlockRow[]).map(rowToBlock);
    const objectives = new Map(
      (objectivesRes.data as ObjectiveRow[]).map(r => [r.id, rowToObjective(r)]),
    );

    const current = blockCovering(blocks, today);

    // One progress computation per call: the named block when there is one,
    // else the current block. Both are the heavy part of this tool.
    let requested: unknown;
    if (blockId) {
      const block = blocks.find(b => b.id === blockId);
      if (!block) throw new ToolInputError('block_id does not name one of your blocks.');
      requested = {
        ...blockSummary(block, objectives, todayDate),
        progress: includeProgress ? await progressFor(supabase, userId, block, todayDate) : null,
      };
    }
    const currentProgress = current && includeProgress && !blockId
      ? await progressFor(supabase, userId, current, todayDate)
      : null;

    return {
      today,
      current: current ? { ...blockSummary(current, objectives, todayDate), progress: currentProgress } : null,
      block: requested,
      blocks: scope === 'all' ? blocks.map(b => blockSummary(b, objectives, todayDate)) : undefined,
      objectives: includeObjectives ? [...objectives.values()].map(objectiveSummary) : undefined,
    };
  },
};
