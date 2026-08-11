import { parseISO } from 'date-fns';
import type { McpToolDef } from '../protocol.js';
import { optionalBoolean, optionalEnum } from '../args.js';
import { fetchExpandedSchedule, todayIso } from '../data.js';
import { fetchPeriodInputs } from '../../reviewData.js';
import type { ObjectiveRow, TrainingBlockRow } from '../../../../src/lib/db/types.js';
import type { Objective, TrainingBlock } from '../../../../src/types/blocks.js';
import { rowToBlock, rowToObjective } from '../../../../src/lib/blocks/mapping.js';
import { blockCovering, blockPeriod, blockWeeks } from '../../../../src/lib/blocks/period.js';
import { computeBlockProgress } from '../../../../src/lib/blocks/progress.js';
import { describeRecord } from '../../../../src/lib/tracking/records.js';

// Training-block tool: blocks, linked objectives, and target-vs-actual
// attainment. All attainment numbers come from computeBlockProgress — the
// same pre-computed values the coach prompt cites.

function blockSummary(block: TrainingBlock, objectives: Map<string, Objective>) {
  const objective = block.objectiveId ? objectives.get(block.objectiveId) ?? null : null;
  return {
    id: block.id,
    name: block.name,
    intent: block.intent,
    phase: block.phase ?? null,
    start_date: block.startDate,
    end_date_exclusive: block.endDateExclusive,
    weeks: blockWeeks(block),
    weekly_targets: block.weeklyTargets,
    objective: objective
      ? {
          name: objective.name,
          discipline: objective.discipline,
          target_date: objective.targetDate ?? null,
          status: objective.status,
          notes: objective.notes ?? null,
        }
      : null,
  };
}

export const getTrainingBlocksTool: McpToolDef = {
  name: 'get_training_blocks',
  description:
    'Training blocks (Monday-aligned mesocycles) with their objectives and, for the current block, ' +
    'computed weekly-target attainment (targets vs logged actuals, per week and to date). ' +
    'Numbers are pre-computed — cite them, never recompute.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['current', 'all'], description: 'Default "current".' },
      include_progress: { type: 'boolean', description: 'Compute attainment for the current block (default true).' },
    },
  },
  async run(supabase, userId, args) {
    const scope = optionalEnum(args, 'scope', ['current', 'all'] as const, 'current');
    const includeProgress = optionalBoolean(args, 'include_progress', true);

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

    const today = todayIso();
    const current = blockCovering(blocks, today);

    let progress: unknown = null;
    if (current && includeProgress) {
      const period = blockPeriod(current);
      const [inputs, { occurrences }] = await Promise.all([
        fetchPeriodInputs(supabase, userId, period),
        fetchExpandedSchedule(supabase, userId, current.endDateExclusive),
      ]);
      const plannedEvents = occurrences.filter(
        e => e.date >= current.startDate && e.date < current.endDateExclusive,
      );
      const result = computeBlockProgress({ ...inputs, block: current, plannedEvents }, parseISO(today));
      progress = {
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

    return {
      today,
      current: current ? { ...blockSummary(current, objectives), progress } : null,
      blocks: scope === 'all' ? blocks.map(b => blockSummary(b, objectives)) : undefined,
    };
  },
};
