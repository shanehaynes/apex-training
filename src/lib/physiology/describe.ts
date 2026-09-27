import { format, parseISO } from 'date-fns';
import type { PhysiologySummary, WeekTonnage, WeekZoneMinutes } from './types.js';

// ─── describePhysiology ───────────────────────────────────────────────────────
// The prompt block. Tags and the closing rule line are the contract the next
// wave's prompt builder relies on; the wording between them is free to tune.
// Nothing in the body may contain '<' — the tags are the only markup, and a
// stray angle bracket would read as one to the model.

const WEEK_LABELS = ['W-4', 'W-3', 'W-2', 'W-1', 'this week'] as const;

const weekLabel = (i: number) => WEEK_LABELS[i] ?? `W${i}`;

function weekLegend(summary: PhysiologySummary): string {
  const parts = summary.weekStarts.map((start, i) => {
    const from = format(parseISO(start), 'MMM d');
    return i === summary.weekStarts.length - 1
      ? `${weekLabel(i)} = ${from} through ${format(parseISO(summary.today), 'MMM d')}`
      : `${weekLabel(i)} = week of ${from}`;
  });
  return `Weeks (Monday start): ${parts.join(', ')}`;
}

function zoneLine(byWeek: WeekZoneMinutes[], method: PhysiologySummary['zoneMethod']): string {
  const cells = byWeek.map((w, i) => `${weekLabel(i)}: ${w.minutes ? w.minutes.join('/') : '—'}`);
  const note =
    method === 'device' ? 'from device zone data'
    : method === 'avgHr' ? 'each session counted whole in the zone of its average HR — a coarse estimate'
    : 'device zone data where synced, otherwise whole sessions in the zone of their average HR';
  return `Zone minutes Z1/Z2/Z3/Z4/Z5 (${note}) — ${cells.join(' · ')}`;
}

function loadLine(load: NonNullable<PhysiologySummary['load']>): string {
  const unit = load.source === 'trainingLoad' ? 'device training load' : 'cardio minutes; no device training load synced';
  const ratio = load.ratio === null ? 'ratio n/a, no chronic baseline' : `ratio ${load.ratio.toFixed(2)}`;
  return `Load (${unit}): acute 7d ${load.acute7d} vs chronic weekly avg ${load.chronicWeeklyAvg28d} (${ratio})`;
}

function tonnageLine(byWeek: WeekTonnage[]): string {
  const cells = byWeek.map((w, i) => `${weekLabel(i)}: ${w.tonnageLb === null ? '—' : `${w.tonnageLb.toLocaleString('en-US')} lb`}`);
  return `Strength tonnage by week (logged sets, weight × reps): ${cells.join(' · ')}`;
}

function hrvLine(hrv: NonNullable<PhysiologySummary['hrv']>): string {
  return hrv.mean7d === null
    ? `HRV: 28d mean ${hrv.mean28d} ms (no reading in the last 7 days)`
    : `HRV: 7d mean ${hrv.mean7d} ms vs 28d mean ${hrv.mean28d} ms`;
}

export function describePhysiology(summary: PhysiologySummary): string {
  const lines: string[] = [];
  if (summary.zoneMinutesByWeek) lines.push(zoneLine(summary.zoneMinutesByWeek, summary.zoneMethod));
  if (summary.load) lines.push(loadLine(summary.load));
  if (summary.tonnageByWeek) lines.push(tonnageLine(summary.tonnageByWeek));
  if (summary.hrv) lines.push(hrvLine(summary.hrv));
  if (lines.length === 0) return '';

  return [
    '<physiology>',
    'PHYSIOLOGY (last 4 completed weeks + this week; every number is pre-computed):',
    weekLegend(summary),
    ...lines,
    '</physiology>',
    'Cite these numbers; use the read tools for anything older or finer-grained. Never recompute or invent others.',
  ].join('\n');
}
