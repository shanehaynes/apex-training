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
  // Activity-attached HRV keeps the line it always had; Health's overnight
  // SDNN says what it is.
  const label = hrv.source === 'daily' ? 'HRV (overnight SDNN, Apple Health)' : 'HRV';
  return hrv.mean7d === null
    ? `${label}: 28d mean ${hrv.mean28d} ms (no reading in the last 7 days)`
    : `${label}: 7d mean ${hrv.mean7d} ms vs 28d mean ${hrv.mean28d} ms`;
}

/** 432 → "7h 12m". */
function hoursMinutes(minutes: number): string {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const shortDate = (iso: string) => format(parseISO(iso), 'MMM d');

function sleepLine(sleep: NonNullable<PhysiologySummary['sleep']>): string {
  const last = sleep.lastNight === null ? 'no reading for last night' : `last night ${hoursMinutes(sleep.lastNight)}`;
  const recent = sleep.mean7d === null ? '' : `7d mean ${hoursMinutes(sleep.mean7d)} vs `;
  return `Sleep (Apple Health): ${last} · ${recent}28d mean ${hoursMinutes(sleep.mean28d)}`;
}

function restingHrLine(hr: NonNullable<PhysiologySummary['restingHr']>): string {
  const recent = hr.mean7d === null ? '' : `7d mean ${hr.mean7d} vs `;
  return `Resting HR (Apple Health): ${hr.latest.bpm} bpm on ${shortDate(hr.latest.date)} · ${recent}28d mean ${hr.mean28d} bpm`;
}

function stepsLine(steps: NonNullable<PhysiologySummary['steps']>): string {
  const recent = steps.mean7d === null ? '' : `7d mean ${steps.mean7d.toLocaleString('en-US')} vs `;
  return `Steps per completed day (Apple Health): ${recent}28d mean ${steps.mean28d.toLocaleString('en-US')}`;
}

function bodyMassLine(mass: NonNullable<PhysiologySummary['bodyMass']>): string {
  const change = mass.change28dLb === null
    ? ''
    : ` (${mass.change28dLb > 0 ? '+' : ''}${mass.change28dLb} lb over 28 days)`;
  return `Body mass (Apple Health): ${mass.latest.lb} lb on ${shortDate(mass.latest.date)}${change}`;
}

export function describePhysiology(summary: PhysiologySummary): string {
  const lines: string[] = [];
  if (summary.zoneMinutesByWeek) lines.push(zoneLine(summary.zoneMinutesByWeek, summary.zoneMethod));
  if (summary.load) lines.push(loadLine(summary.load));
  if (summary.tonnageByWeek) lines.push(tonnageLine(summary.tonnageByWeek));
  if (summary.hrv) lines.push(hrvLine(summary.hrv));
  if (summary.sleep) lines.push(sleepLine(summary.sleep));
  if (summary.restingHr) lines.push(restingHrLine(summary.restingHr));
  if (summary.steps) lines.push(stepsLine(summary.steps));
  if (summary.bodyMass) lines.push(bodyMassLine(summary.bodyMass));
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
