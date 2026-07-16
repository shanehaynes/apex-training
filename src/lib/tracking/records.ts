import { format, parseISO } from 'date-fns';
import type { CardioLogRow, SetLogRow } from '../db/types';
import type { TrackedSectionGroup } from './plan';
import { formatSeconds } from '../time';

// ─── Personal records ─────────────────────────────────────────────────────────
// Pure PR detection over set/cardio logs — computed client-side, never by the
// AI. Matched by exercise name so records follow an exercise across events,
// like last-performance history does. Four record kinds:
//   oneRM     — estimated 1RM (Epley) for sets with weight × reps
//   duration  — longest hold for sets tracked by time with no weight metric
//   reps      — most reps in a set for rep-only exercises (no weight, no time)
//   distance  — longest cardio distance (per unit — "5 mi" never races "8 km")
//   elevation — most cardio elevation gain (per unit)
// A first-ever log of an exercise is never a PR: there is nothing to beat.

interface BaseRecord {
  exerciseName: string;
  /** event_date of the session that held the previous best. */
  previousDate: string;
}

export interface OneRMRecord extends BaseRecord {
  kind: 'oneRM';
  estimatedOneRM: number;
  /** The weight × reps set that produced it. */
  weight: number;
  reps: number;
  previousOneRM: number;
}

export interface DurationRecord extends BaseRecord {
  kind: 'duration';
  seconds: number;
  previousSeconds: number;
}

export interface RepsRecord extends BaseRecord {
  kind: 'reps';
  reps: number;
  previousReps: number;
}

export interface QuantityRecord extends BaseRecord {
  kind: 'distance' | 'elevation';
  value: number;
  /** Normalized unit ('mi', 'km', 'ft', 'm', or '' for bare numbers). */
  unit: string;
  previousValue: number;
}

export type PersonalRecord = OneRMRecord | DurationRecord | RepsRecord | QuantityRecord;

// ─── Parsing free-text tracker values ─────────────────────────────────────────

/**
 * Leading number from a free-text tracker value: "185lb" → 185, "62.5 kg" →
 * 62.5, "BW" → null. Unparseable values simply don't participate in PRs.
 */
export function parseLeadingNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Duration in seconds: "90s" → 90, "2 min" → 120, "1:30" → 90, "1:05:00" →
 * 3900, bare "60" → 60 (seconds). Unknown units return null — no guessing.
 */
export function parseDurationSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();

  const colon = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const [, a, b, c] = colon;
    return c !== undefined
      ? Number(a) * 3600 + Number(b) * 60 + Number(c)
      : Number(a) * 60 + Number(b);
  }

  const match = v.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  if (unit === '' || unit === 's' || unit.startsWith('sec')) return n;
  if (unit === 'm' || unit.startsWith('min')) return n * 60;
  if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) return n * 3600;
  return null;
}

/**
 * Canonical display for a value that is entirely one duration — "90" →
 * "1:30", "2 min" → "2:00", "45" → "45s". Null when the text carries anything
 * beyond a single number+unit or colon time ("10s on, 5s off", "90 sec/side"),
 * so free-form entries are never rewritten: parseDurationSeconds reads a
 * leading duration out of such strings, but canonicalizing would drop the rest.
 */
export function canonicalDurationText(value: string): string | null {
  const v = value.trim();
  if (!/^\d+(?:\.\d+)?\s*[a-z]*$/i.test(v) && !/^\d+:\d{1,2}(?::\d{1,2})?$/.test(v)) return null;
  const seconds = parseDurationSeconds(v);
  return seconds === null ? null : formatSeconds(seconds);
}

const UNIT_ALIASES: Record<string, string> = {
  mi: 'mi', mile: 'mi', miles: 'mi',
  km: 'km', k: 'km',
  m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  ft: 'ft', feet: 'ft', foot: 'ft',
};

/**
 * Magnitude + normalized unit from a cardio value: "5 mi" → {5, 'mi'},
 * "1,200 ft" → {1200, 'ft'}, "5.2" → {5.2, ''}. Unrecognized units keep
 * their lowercased text so like still compares with like.
 */
export function parseQuantity(value: string | null | undefined): { value: number; unit: string } | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:,\d{3})*(?:\.\d+)?)\s*([a-zA-Z]*)/);
  if (!match) return null;
  const n = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const raw = match[2].toLowerCase();
  return { value: n, unit: UNIT_ALIASES[raw] ?? raw };
}

/**
 * Epley formula: 1RM = weight × (1 + reps/30). A single rep IS the 1RM —
 * the formula would otherwise inflate it to weight × 31/30.
 */
export function estimateOneRepMax(weight: number, reps: number): number {
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}

// ─── Best-effort tracking maps ────────────────────────────────────────────────

interface BestSet {
  oneRM: number;
  weight: number;
  reps: number;
  date: string;
}

interface BestValue {
  value: number;
  date: string;
}

function keepBetterSet(map: Map<string, BestSet>, key: string, candidate: BestSet) {
  const current = map.get(key);
  if (!current || candidate.oneRM > current.oneRM) map.set(key, candidate);
}

function keepBetterValue(map: Map<string, BestValue>, key: string, candidate: BestValue) {
  const current = map.get(key);
  if (!current || candidate.value > current.value) map.set(key, candidate);
}

/**
 * A set row's PR dimension, decided per row: weight × reps when the weight
 * parses (oneRM), otherwise its duration when that parses (duration),
 * otherwise its rep count alone (reps). A weighted exercise never earns
 * duration or rep-count PRs.
 */
export function classifySet(weight: string | null, reps: string | null, duration: string | null):
  | { kind: 'oneRM'; weight: number; reps: number; oneRM: number }
  | { kind: 'duration'; seconds: number }
  | { kind: 'reps'; reps: number }
  | null {
  const w = parseLeadingNumber(weight);
  if (w !== null && w > 0) {
    const r = parseLeadingNumber(reps);
    if (r === null || r < 1) return null;
    return { kind: 'oneRM', weight: w, reps: r, oneRM: estimateOneRepMax(w, r) };
  }
  const seconds = parseDurationSeconds(duration);
  if (seconds !== null) return { kind: 'duration', seconds };
  const r = parseLeadingNumber(reps);
  return r !== null && r >= 1 ? { kind: 'reps', reps: r } : null;
}

/**
 * Best prior estimated 1RM per exercise name. Autofilled zero-fills are
 * skipped (a skipped set is not a performance), as is anything without a
 * parseable weight and at least one rep.
 */
export function bestHistoricalOneRM(rows: SetLogRow[]): Map<string, BestSet> {
  const byName = new Map<string, BestSet>();
  for (const row of rows) {
    if (row.is_autofilled) continue;
    const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
    if (set?.kind !== 'oneRM') continue;
    keepBetterSet(byName, row.exercise_name, { oneRM: set.oneRM, weight: set.weight, reps: set.reps, date: row.event_date });
  }
  return byName;
}

/** Longest prior duration per exercise name, for rows with no weight metric. */
export function bestHistoricalDuration(rows: SetLogRow[]): Map<string, BestValue> {
  const byName = new Map<string, BestValue>();
  for (const row of rows) {
    if (row.is_autofilled) continue;
    const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
    if (set?.kind !== 'duration') continue;
    keepBetterValue(byName, row.exercise_name, { value: set.seconds, date: row.event_date });
  }
  return byName;
}

/** Most prior reps in a set per exercise name, for rep-only rows. */
export function bestHistoricalReps(rows: SetLogRow[]): Map<string, BestValue> {
  const byName = new Map<string, BestValue>();
  for (const row of rows) {
    if (row.is_autofilled) continue;
    const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
    if (set?.kind !== 'reps') continue;
    keepBetterValue(byName, row.exercise_name, { value: set.reps, date: row.event_date });
  }
  return byName;
}

const quantityKey = (name: string, unit: string) => `${name}|${unit}`;

/** Best prior cardio distance and elevation gain, per exercise name + unit. */
export function bestHistoricalCardio(rows: CardioLogRow[]): {
  distance: Map<string, BestValue>;
  elevation: Map<string, BestValue>;
} {
  const distance = new Map<string, BestValue>();
  const elevation = new Map<string, BestValue>();
  for (const row of rows) {
    const dist = parseQuantity(row.distance);
    if (dist) keepBetterValue(distance, quantityKey(row.exercise_name, dist.unit), { value: dist.value, date: row.event_date });
    const elev = parseQuantity(row.elevation_gain);
    if (elev) keepBetterValue(elevation, quantityKey(row.exercise_name, elev.unit), { value: elev.value, date: row.event_date });
  }
  return { distance, elevation };
}

// ─── Session PR computation ───────────────────────────────────────────────────

/**
 * PRs set this session, compared against prior history. An exercise with no
 * prior history can't set a record — there is nothing to beat, and announcing
 * a PR on every first-time exercise would be noise.
 */
export function computeSessionPRs(
  groups: TrackedSectionGroup[],
  history: SetLogRow[],
  cardioHistory: CardioLogRow[] = [],
): PersonalRecord[] {
  const priorOneRM = bestHistoricalOneRM(history);
  const priorDuration = bestHistoricalDuration(history);
  const priorReps = bestHistoricalReps(history);
  const priorCardio = bestHistoricalCardio(cardioHistory);

  const currentOneRM = new Map<string, BestSet>();
  const currentDuration = new Map<string, BestValue>();
  const currentReps = new Map<string, BestValue>();
  const currentDistance = new Map<string, { value: number; unit: string }>();
  const currentElevation = new Map<string, { value: number; unit: string }>();

  for (const group of groups) {
    for (const tracked of group.exercises) {
      const name = tracked.exercise.name;
      if (tracked.isCardio) {
        if (!tracked.cardio) continue;
        const dist = parseQuantity(tracked.cardio.distance);
        if (dist && (currentDistance.get(name)?.value ?? 0) < dist.value) currentDistance.set(name, dist);
        const elev = parseQuantity(tracked.cardio.elevationGain);
        if (elev && (currentElevation.get(name)?.value ?? 0) < elev.value) currentElevation.set(name, elev);
        continue;
      }
      for (const set of tracked.sets) {
        if (set.isAutofilled) continue;
        const classified = classifySet(set.actualWeight, set.actualReps, set.actualDuration);
        if (!classified) continue;
        if (classified.kind === 'oneRM') {
          keepBetterSet(currentOneRM, name, { oneRM: classified.oneRM, weight: classified.weight, reps: classified.reps, date: '' });
        } else if (classified.kind === 'duration') {
          keepBetterValue(currentDuration, name, { value: classified.seconds, date: '' });
        } else {
          keepBetterValue(currentReps, name, { value: classified.reps, date: '' });
        }
      }
    }
  }

  const prs: PersonalRecord[] = [];

  for (const [name, current] of currentOneRM) {
    const prior = priorOneRM.get(name);
    if (!prior || current.oneRM <= prior.oneRM) continue;
    prs.push({
      kind: 'oneRM',
      exerciseName: name,
      estimatedOneRM: current.oneRM,
      weight: current.weight,
      reps: current.reps,
      previousOneRM: prior.oneRM,
      previousDate: prior.date,
    });
  }

  for (const [name, current] of currentDuration) {
    const prior = priorDuration.get(name);
    if (!prior || current.value <= prior.value) continue;
    prs.push({
      kind: 'duration',
      exerciseName: name,
      seconds: current.value,
      previousSeconds: prior.value,
      previousDate: prior.date,
    });
  }

  for (const [name, current] of currentReps) {
    const prior = priorReps.get(name);
    if (!prior || current.value <= prior.value) continue;
    prs.push({
      kind: 'reps',
      exerciseName: name,
      reps: current.value,
      previousReps: prior.value,
      previousDate: prior.date,
    });
  }

  const quantityPRs = (
    kind: 'distance' | 'elevation',
    current: Map<string, { value: number; unit: string }>,
    prior: Map<string, BestValue>,
  ) => {
    for (const [name, candidate] of current) {
      const best = prior.get(quantityKey(name, candidate.unit));
      if (!best || candidate.value <= best.value) continue;
      prs.push({
        kind,
        exerciseName: name,
        value: candidate.value,
        unit: candidate.unit,
        previousValue: best.value,
        previousDate: best.date,
      });
    }
  };
  quantityPRs('distance', currentDistance, priorCardio.distance);
  quantityPRs('elevation', currentElevation, priorCardio.elevation);

  return prs;
}

// ─── Display ──────────────────────────────────────────────────────────────────

export { formatSeconds } from '../time';

function quantityLabel(value: number, unit: string): string {
  return unit ? `${value} ${unit}` : String(value);
}

/**
 * One-line description of the record minus the exercise name, shared by the
 * summary popup and the AI recap: "est. 1RM 216 (190 × 5), up from 206 on Jun 12".
 */
export function describeRecord(pr: PersonalRecord): string {
  const prevDate = format(parseISO(pr.previousDate), 'MMM d');
  switch (pr.kind) {
    case 'oneRM':
      return `est. 1RM ${Math.round(pr.estimatedOneRM)} (${pr.weight} × ${pr.reps}), up from ${Math.round(pr.previousOneRM)} on ${prevDate}`;
    case 'duration':
      return `${formatSeconds(pr.seconds)}, up from ${formatSeconds(pr.previousSeconds)} on ${prevDate}`;
    case 'reps':
      return `${pr.reps} reps, up from ${pr.previousReps} on ${prevDate}`;
    case 'distance':
      return `${quantityLabel(pr.value, pr.unit)}, up from ${quantityLabel(pr.previousValue, pr.unit)} on ${prevDate}`;
    case 'elevation':
      return `${quantityLabel(pr.value, pr.unit)} elevation, up from ${quantityLabel(pr.previousValue, pr.unit)} on ${prevDate}`;
  }
}
