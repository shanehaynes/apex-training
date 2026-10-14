import { format, parseISO } from 'date-fns';
import { describeRecord, describeRecordForPeople } from '../tracking/records.js';
import { lbToUnit, type WeightUnit } from '../tracking/weight.js';
import type { DatedPersonalRecord } from './types.js';

// Small display helpers shared by the AI recap (recap.ts) and the email
// renderer (email.ts) so both always show identical figures.

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * A pound figure (every stat is computed in pounds) shown in the athlete's
 * unit: "1,250 lb", or converted, "567 kg". Conversion happens only here,
 * at display — the stored stats stay pounds.
 */
export function formatWeight(lb: number, unit: WeightUnit = 'lb'): string {
  return `${formatNumber(lbToUnit(lb, unit))} ${unit}`;
}

/**
 * A tonnage total in the athlete's unit, whole: the stored sum is already
 * rounded to the pound, so a kg reading of it would otherwise carry a
 * meaningless decimal (1,102 lb → "499.9 kg").
 */
export function formatTonnage(lb: number, unit: WeightUnit = 'lb'): string {
  return `${formatNumber(Math.round(lbToUnit(lb, unit)))} ${unit}`;
}

export function formatMinutes(totalMinutes: number): string {
  const minutes = Math.round(totalMinutes);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "34.2 mi + 12 km" — per-unit sums are never converted or merged. */
export function formatUnitMap(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([unit, value]) => (unit ? `${formatNumber(value)} ${unit}` : formatNumber(value)))
    .join(' + ');
}

export function recordKindLabel(kind: DatedPersonalRecord['kind']): string {
  return kind === 'oneRM' ? 'strength' : kind;
}

export function shortDate(date: string): string {
  return format(parseISO(date), 'MMM d');
}

/** "Bench Press (strength): est. 1RM 216 (190 × 5), up from 206 on Jun 12 — set Jun 26" — pounds, for machine readers. */
export function describeDatedRecord(pr: DatedPersonalRecord): string {
  return `${pr.exerciseName} (${recordKindLabel(pr.kind)}): ${describeRecord(pr)} — set ${shortDate(pr.date)}`;
}

/**
 * describeDatedRecord for the review text a person reads (email, recap):
 * numbers in the athlete's unit, so a PR line sits beside "Heaviest set:
 * 90 kg" as "(90 × 5)", never as unlabelled pounds.
 */
export function describeDatedRecordForPeople(pr: DatedPersonalRecord, unit: WeightUnit = 'lb'): string {
  return `${pr.exerciseName} (${recordKindLabel(pr.kind)}): ${describeRecordForPeople(pr, unit)} — set ${shortDate(pr.date)}`;
}
