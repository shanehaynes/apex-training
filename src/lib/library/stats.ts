import { format, parseISO } from 'date-fns';
import type { CardioLogRow, SetLogRow } from '../db/types';
import {
  classifySet,
  estimateOneRepMax,
  parseQuantity,
} from '../tracking/records';
import { formatSeconds } from '../time';

// ─── Per-exercise library stats ───────────────────────────────────────────────
// Pure computation over one exercise's (pre-canonicalized) log history for the
// library detail page: dominant record kind, all-time PR, per-session trend,
// and recent sessions. Derived on read, never stored — same convention as the
// tracker's PR detection, and reusing its classification so the numbers match
// what the tracker announces.

export type StatKind = 'oneRM' | 'duration' | 'reps' | 'distance';

export interface TrendPoint {
  /** event_date (YYYY-MM-DD). */
  date: string;
  /** Best value that session, in the dominant kind's unit. */
  value: number;
}

export interface SessionSummary {
  date: string;
  /** Human-readable logged sets in order, e.g. "185 × 5" or "0:45". */
  sets: string[];
}

export interface ExerciseStats {
  kind: StatKind | null;
  /** Axis/PR unit label: "est. 1RM", "hold", "reps", or the cardio unit ("mi"). */
  kindLabel: string;
  /** All-time best, formatted, with its date — null when nothing parseable is logged. */
  pr: { display: string; date: string } | null;
  trend: TrendPoint[];
  sessions: SessionSummary[];
  totalSessions: number;
}

const EMPTY: ExerciseStats = { kind: null, kindLabel: '', pr: null, trend: [], sessions: [], totalSessions: 0 };

function describeSet(row: SetLogRow): string | null {
  const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
  if (!set) return null;
  switch (set.kind) {
    case 'oneRM':    return `${set.weight} × ${set.reps}`;
    case 'duration': return formatSeconds(set.seconds);
    case 'reps':     return `${set.reps} reps`;
  }
}

export function formatTrendValue(kind: StatKind | null, value: number, unit = ''): string {
  switch (kind) {
    case 'oneRM':    return String(Math.round(value));
    case 'duration': return formatSeconds(value);
    case 'reps':     return String(value);
    case 'distance': return unit ? `${value} ${unit}` : String(value);
    default:         return String(value);
  }
}

export function formatStatDate(date: string): string {
  return format(parseISO(date), 'MMM d, yyyy');
}

/** Stats over set-tracked history. Rows may span spellings — canonicalize first. */
function setStats(rows: SetLogRow[]): ExerciseStats {
  const real = rows.filter(r => !r.is_autofilled);

  // Dominant kind decides the PR dimension and the trend axis; a weighted
  // exercise never earns duration/rep records (mirrors records.ts).
  const kindCounts = new Map<StatKind, number>();
  const classified = real.map(r => ({
    row: r,
    set: classifySet(r.actual_weight, r.actual_reps, r.actual_duration),
  }));
  for (const { set } of classified) {
    if (set) kindCounts.set(set.kind, (kindCounts.get(set.kind) ?? 0) + 1);
  }
  const kind = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Best value of the dominant kind per session date.
  const bestByDate = new Map<string, number>();
  for (const { row, set } of classified) {
    if (!set || set.kind !== kind) continue;
    const value =
      set.kind === 'oneRM' ? estimateOneRepMax(set.weight, set.reps)
      : set.kind === 'duration' ? set.seconds
      : set.reps;
    if (value > (bestByDate.get(row.event_date) ?? -Infinity)) bestByDate.set(row.event_date, value);
  }
  const trend = [...bestByDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const best = trend.reduce<TrendPoint | null>(
    (acc, p) => (acc && acc.value >= p.value ? acc : p), null,
  );

  // Recent sessions, newest first, with the sets actually logged.
  const byDate = new Map<string, string[]>();
  for (const { row, set } of classified) {
    if (!set) continue;
    const label = describeSet(row);
    if (!label) continue;
    const list = byDate.get(row.event_date) ?? [];
    list.push(label);
    byDate.set(row.event_date, list);
  }
  const sessions = [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([date, sets]) => ({ date, sets }));

  const kindLabel = kind === 'oneRM' ? 'est. 1RM' : kind === 'duration' ? 'hold' : kind === 'reps' ? 'reps' : '';
  return {
    kind,
    kindLabel,
    pr: best ? { display: formatTrendValue(kind, best.value), date: best.date } : null,
    trend,
    sessions,
    totalSessions: byDate.size,
  };
}

/** Stats over cardio history: distance trend in the dominant unit. */
function cardioStats(rows: CardioLogRow[]): ExerciseStats {
  const real = rows.filter(r => !r.is_autofilled);
  const parsed = real
    .map(r => ({ row: r, qty: parseQuantity(r.distance) }))
    .filter((p): p is { row: CardioLogRow; qty: { value: number; unit: string } } => p.qty !== null);

  const unitCounts = new Map<string, number>();
  for (const { qty } of parsed) unitCounts.set(qty.unit, (unitCounts.get(qty.unit) ?? 0) + 1);
  const unit = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const bestByDate = new Map<string, number>();
  for (const { row, qty } of parsed) {
    if (qty.unit !== unit) continue;
    if (qty.value > (bestByDate.get(row.event_date) ?? -Infinity)) bestByDate.set(row.event_date, qty.value);
  }
  const trend = [...bestByDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const best = trend.reduce<TrendPoint | null>(
    (acc, p) => (acc && acc.value >= p.value ? acc : p), null,
  );

  const byDate = new Map<string, string[]>();
  for (const row of real) {
    const parts: string[] = [];
    if (row.duration_minutes != null) parts.push(`${row.duration_minutes} min`);
    if (row.distance) parts.push(row.distance);
    if (row.elevation_gain) parts.push(`↑ ${row.elevation_gain}`);
    if (parts.length) byDate.set(row.event_date, [...(byDate.get(row.event_date) ?? []), parts.join(' · ')]);
  }
  const sessions = [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([date, sets]) => ({ date, sets }));

  return {
    kind: unit !== undefined ? 'distance' : null,
    kindLabel: unit ?? '',
    pr: best ? { display: formatTrendValue('distance', best.value, unit), date: best.date } : null,
    trend,
    sessions,
    totalSessions: byDate.size,
  };
}

/**
 * Stats for one exercise's history. Set logs win when both exist (an exercise
 * is either set-tracked or cardio; mixed history means it changed category —
 * the richer side is the useful one).
 */
export function buildExerciseStats(setRows: SetLogRow[], cardioRows: CardioLogRow[]): ExerciseStats {
  if (setRows.some(r => !r.is_autofilled)) return setStats(setRows);
  if (cardioRows.some(r => !r.is_autofilled)) return cardioStats(cardioRows);
  return EMPTY;
}

// ─── Last-performed map for the library list ──────────────────────────────────

export interface NameDateRow {
  exercise_name: string;
  event_date: string;
}

/**
 * Most recent log date per canonical exercise name. Input rows carry whatever
 * spelling was logged; `toCanonical` is the alias index's normalized-name map.
 */
export function lastPerformedByCanonical(
  rows: NameDateRow[],
  toCanonical: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const canonical = toCanonical.get(row.exercise_name.trim().replace(/\s+/g, ' ').toLowerCase()) ?? row.exercise_name;
    const current = out.get(canonical);
    if (!current || row.event_date > current) out.set(canonical, row.event_date);
  }
  return out;
}
