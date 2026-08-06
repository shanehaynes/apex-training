import type { BlockProgress, TargetAttainment } from './progress';
import type { Objective } from '../../types/blocks';

// Everything the coach is told about the active block, rendered here so
// src/lib/coach/prompt.ts only concatenates. Same principle as the rest of
// the app: the numbers are computed deterministically and handed over; the
// model narrates them and never recomputes.

export interface BlockPromptSummary {
  name: string;
  intent: string;
  phase?: string;
  /** "week 3 of 8" — null when the block has not started or has ended. */
  weekLabel: string | null;
  rangeLabel: string;
  objective: { name: string; targetDate?: string } | null;
  /** Pre-rendered "cardio 210/300 min (70%)" lines for the in-progress week. */
  currentWeek: string[];
  /** Same, for completed weeks only. Empty during week 1. */
  toDate: string[];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatNumber(value: number): string {
  return round(value).toLocaleString('en-US');
}

/** "cardio 210/300 min (70%)", or "vertical gain 1,150/2,000 ft (58%)". */
export function formatAttainment(a: TargetAttainment): string {
  const unit = a.unit ? ` ${a.unit}` : '';
  const pct = a.pct === null ? '' : ` (${Math.round(a.pct * 100)}%)`;
  const base = `${a.label.toLowerCase()} ${formatNumber(a.actual)}/${formatNumber(a.targetForWindow)}${unit}${pct}`;
  if (!a.unmatchedUnits) return base;
  // Disclose rather than convert: the repo never converts across units, so a
  // target in ft with logs in m would otherwise read as an unexplained miss.
  const others = Object.entries(a.unmatchedUnits)
    .map(([u, v]) => `${formatNumber(v)} ${u}`)
    .join(', ');
  return `${base} [also logged: ${others}, not counted — different unit]`;
}

export function buildBlockPromptSummary(
  progress: BlockProgress,
  objective: Objective | null,
): BlockPromptSummary {
  const { block, weeksTotal, currentWeek } = progress;
  const inProgress = currentWeek === null ? null : progress.weeks[currentWeek - 1];

  return {
    name:       block.name,
    intent:     block.intent,
    phase:      block.phase,
    weekLabel:  currentWeek === null ? null : `week ${currentWeek} of ${weeksTotal}`,
    rangeLabel: progress.period.label,
    objective:  objective ? { name: objective.name, targetDate: objective.targetDate } : null,
    currentWeek: (inProgress?.attainment ?? []).map(formatAttainment),
    toDate:     progress.weeksElapsed > 0 ? progress.toDate.attainment.map(formatAttainment) : [],
  };
}
