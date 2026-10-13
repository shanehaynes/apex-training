import type { Exercise, PlannedSet } from '../../types/workout';

// ─── Per-set target authoring ────────────────────────────────────────────────
// The pure half of the exercise editor's "Per-set targets" disclosure
// (src/components/modal/PlannedSetsEditor.tsx; ApexCore/Schedule/PlannedSets.swift
// is the iOS mirror). Targets are free text ("~35 lbs", "4–6", "90 sec/side")
// because that is what the prescription fields and the tracker take; the
// presets read the leading number out of a target, do their arithmetic, and
// write it back wearing the same unit. Nothing here touches the tracker's
// resolvePlannedSets: an exercise without plannedSets still synthesizes
// uniform rows from the base prescription.

export type TargetField = 'targetWeight' | 'targetReps' | 'targetDuration';

export const TARGET_FIELDS: readonly TargetField[] = ['targetWeight', 'targetReps', 'targetDuration'];

export const TARGET_LABELS: Record<TargetField, string> = {
  targetWeight: 'Weight',
  targetReps: 'Reps',
  targetDuration: 'Duration',
};

/** The base prescription a target column mirrors. */
const BASE_FIELD: Record<TargetField, 'weight' | 'reps' | 'duration'> = {
  targetWeight: 'weight',
  targetReps: 'reps',
  targetDuration: 'duration',
};

export type BasePrescription = Pick<Exercise, 'sets' | 'reps' | 'weight' | 'duration' | 'plannedSets'>;

/**
 * The columns the table shows: every dimension the base prescription or any
 * authored row names. An exercise that names none gets weight + reps — the
 * strength default, and the two a ramp is usually written in.
 */
export function targetFields(entry: BasePrescription): TargetField[] {
  const fields = TARGET_FIELDS.filter(field =>
    !!entry[BASE_FIELD[field]] || (entry.plannedSets ?? []).some(row => !!row[field]),
  );
  return fields.length ? fields : ['targetWeight', 'targetReps'];
}

/** How many rows the table has: `sets` when stated, else the authored rows, else 1. */
export function setCount(entry: BasePrescription): number {
  if (entry.sets && entry.sets > 0) return entry.sets;
  return entry.plannedSets?.length || 1;
}

/** One row per set, every row the base prescription — "Apply to all sets". */
export function uniformSets(count: number, base: BasePrescription): PlannedSet[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => row(i + 1, {
    targetWeight: base.weight,
    targetReps: base.reps,
    targetDuration: base.duration,
  }));
}

/**
 * The table at a new set count: existing rows stay as they are, rows past
 * the count go, and new rows repeat the last one (a 5th set of a 4-set ramp
 * is most likely another top set), or the base when there is nothing to
 * repeat. Set numbers are always 1..count.
 */
export function resizeSets(rows: PlannedSet[], count: number, base: BasePrescription): PlannedSet[] {
  const target = Math.max(1, count);
  const out: PlannedSet[] = [];
  for (let i = 0; i < target; i++) {
    const source = rows[i] ?? rows[rows.length - 1] ?? uniformSets(1, base)[0];
    out.push(row(i + 1, source));
  }
  return out;
}

/** The rows the editor shows: the authored ones at the current count, else the base repeated. */
export function tableRows(entry: BasePrescription): PlannedSet[] {
  const count = setCount(entry);
  return entry.plannedSets?.length ? resizeSets(entry.plannedSets, count, entry) : uniformSets(count, entry);
}

/** One cell edited; empty text clears the target. */
export function setTarget(rows: PlannedSet[], setNumber: number, field: TargetField, value: string): PlannedSet[] {
  return rows.map(r => (r.setNumber === setNumber ? row(r.setNumber, { ...r, [field]: value.trim() || undefined }) : r));
}

// ─── Numbers inside free text ────────────────────────────────────────────────

export interface ParsedTarget {
  value: number;
  /** Text before the number ("~", "BW + "). */
  prefix: string;
  /** Text after it (" lbs", "–6", " sec/side"). */
  suffix: string;
}

const NUMBER = /-?\d+(?:\.\d+)?/;

/** The first number in a target and the text around it; null when there is none. */
export function parseTarget(text: string | undefined): ParsedTarget | null {
  if (!text) return null;
  const match = NUMBER.exec(text);
  if (!match) return null;
  return {
    value: parseFloat(match[0]),
    prefix: text.slice(0, match.index),
    suffix: text.slice(match.index + match[0].length),
  };
}

/** A suffix that is only a unit ("lbs", " kg", "s", "%") and can follow any number. */
const UNIT_SUFFIX = /^\s*[a-zA-Z%]+\.?$/;

/**
 * The unit a preset writes: whatever the user typed after the number in the
 * preset's own input, else the base target's unit when it has a plain one
 * ("~35 lbs" → " lbs"; "4–6" contributes nothing).
 */
export function unitFor(typed: string, base: string | undefined): string {
  const own = parseTarget(typed);
  if (own && own.suffix.trim()) return own.suffix;
  const inherited = parseTarget(base);
  if (inherited && UNIT_SUFFIX.test(inherited.suffix)) return inherited.suffix;
  return '';
}

/** 147.5 → "147.5", 150 → "150" — never trailing zeros or float noise. */
export function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatTarget(value: number, unit: string): string {
  return `${formatNumber(value)}${unit}`;
}

/** Plate math for weight, whole units for everything else. */
export function stepFor(field: TargetField): number {
  return field === 'targetWeight' ? 2.5 : 1;
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

// ─── Presets ─────────────────────────────────────────────────────────────────

export interface PresetOptions {
  /** Rounds every intermediate value (default: stepFor(field)). */
  step?: number;
  /** Appended to every value (default: ''). */
  unit?: string;
}

/**
 * Linear from `first` on set 1 to `last` on the final set; one set gets
 * `first`. Only `field` changes — the other columns ride along untouched.
 */
export function rampSets(
  rows: PlannedSet[], field: TargetField, first: number, last: number, options: PresetOptions = {},
): PlannedSet[] {
  const step = options.step ?? stepFor(field);
  const unit = options.unit ?? '';
  const n = rows.length;
  return rows.map((r, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    return row(r.setNumber, { ...r, [field]: formatTarget(snap(first + (last - first) * t, step), unit) });
  });
}

/**
 * Up to `peak` in the middle and back down to `low`; both ends get `low`. An
 * even count has two middle sets, which share the climb's upper value.
 */
export function pyramidSets(
  rows: PlannedSet[], field: TargetField, low: number, peak: number, options: PresetOptions = {},
): PlannedSet[] {
  const step = options.step ?? stepFor(field);
  const unit = options.unit ?? '';
  const n = rows.length;
  const centre = (n - 1) / 2;
  return rows.map((r, i) => {
    const t = centre > 0 ? 1 - Math.abs(i - centre) / centre : 1;
    return row(r.setNumber, { ...r, [field]: formatTarget(snap(low + (peak - low) * t, step), unit) });
  });
}

/**
 * The top weight on the leading sets and `backoffs` trailing sets at
 * `percent` of it — "5×5 at 80% then back-offs" with the top written out.
 * At least one top set always remains, however many back-offs are asked for.
 */
export function topSetBackoffs(
  rows: PlannedSet[], field: TargetField, top: number, backoffs: number, percent: number, options: PresetOptions = {},
): PlannedSet[] {
  const step = options.step ?? stepFor(field);
  const unit = options.unit ?? '';
  const n = rows.length;
  const trailing = Math.min(Math.max(0, Math.floor(backoffs)), Math.max(0, n - 1));
  const backoff = snap(top * (percent / 100), step);
  return rows.map((r, i) => row(r.setNumber, {
    ...r, [field]: formatTarget(i >= n - trailing ? backoff : snap(top, step), unit),
  }));
}

// ─── Editor transitions ──────────────────────────────────────────────────────

/**
 * A prescription edit on an entry that has per-set targets: a new set count
 * resizes the table; anything else leaves it alone (the old rule cleared the
 * rows on every edit — now "Apply to all sets" is the explicit way to refill
 * them from the base).
 */
export function withPrescriptionPatch(entry: Exercise, patch: Partial<Exercise>): Exercise {
  const next = { ...entry, ...patch };
  if (!entry.plannedSets?.length || !('sets' in patch)) return next;
  return { ...next, plannedSets: resizeSets(entry.plannedSets, setCount(next), next) };
}

/** A row with only the fields that carry a value, so JSON and equality stay tidy. */
function row(setNumber: number, source: Partial<PlannedSet>): PlannedSet {
  const out: PlannedSet = { setNumber };
  if (source.targetWeight) out.targetWeight = source.targetWeight;
  if (source.targetReps) out.targetReps = source.targetReps;
  if (source.targetDuration) out.targetDuration = source.targetDuration;
  return out;
}
