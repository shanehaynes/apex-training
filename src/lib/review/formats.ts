import { format, parseISO } from 'date-fns';
import { describeRecord } from '../tracking/records';
import type { DatedPersonalRecord } from './types';

// Small display helpers shared by the AI recap (recap.ts) and the email
// renderer (email.ts) so both always show identical figures.

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
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

/** "Bench Press (strength): est. 1RM 216 (190 × 5), up from 206 on Jun 12 — set Jun 26" */
export function describeDatedRecord(pr: DatedPersonalRecord): string {
  return `${pr.exerciseName} (${recordKindLabel(pr.kind)}): ${describeRecord(pr)} — set ${shortDate(pr.date)}`;
}
