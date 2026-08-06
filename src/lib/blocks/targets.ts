import type {
  DistanceUnit,
  ElevationUnit,
  Quantity,
  WeeklyTargets,
  WeeklyTargetKey,
} from '../../types/blocks';

// Shape validation for the weekly_targets JSONB bag.
//
// pickAllowed (api/_lib/allowlist.ts) guards column NAMES; it cannot see
// inside a JSONB value. This module is the shape guard, and it runs on both
// sides — the editor form and api/training-blocks.ts — so the same rules
// apply whether the write came from the app or from a hand-rolled request.
// Same split the codebase already uses: allowlist in api/, shape knowledge
// in src/lib/.

const DISTANCE_UNITS: readonly DistanceUnit[] = ['mi', 'km'];
const ELEVATION_UNITS: readonly ElevationUnit[] = ['ft', 'm'];

/** Counts and minutes: non-negative finite numbers. */
const SCALAR_KEYS = [
  'cardioMinutes',
  'strengthSessions',
  'climbingSessions',
  'longSessionMinutes',
] as const;

const QUANTITY_KEYS = {
  vert: ELEVATION_UNITS,
  distance: DISTANCE_UNITS,
} as const;

export const WEEKLY_TARGET_KEYS: readonly WeeklyTargetKey[] = [
  ...SCALAR_KEYS,
  ...(Object.keys(QUANTITY_KEYS) as Array<keyof typeof QUANTITY_KEYS>),
];

/** Human labels and units, for the editor and the attainment display. */
export const TARGET_META: Record<WeeklyTargetKey, { label: string; unit: string }> = {
  cardioMinutes:      { label: 'Cardio',           unit: 'min' },
  vert:               { label: 'Vertical gain',    unit: '' },
  distance:           { label: 'Distance',         unit: '' },
  strengthSessions:   { label: 'Strength',         unit: 'sessions' },
  climbingSessions:   { label: 'Climbing',         unit: 'sessions' },
  longSessionMinutes: { label: 'Long session',     unit: 'min' },
};

export class TargetValidationError extends Error {}

function requireNonNegative(key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TargetValidationError(`${key} must be a finite number`);
  }
  if (value < 0) throw new TargetValidationError(`${key} must not be negative`);
  return value;
}

function parseQuantityTarget<U extends string>(
  key: string,
  raw: unknown,
  units: readonly U[],
): Quantity<U> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TargetValidationError(`${key} must be an object like { value, unit }`);
  }
  const { value, unit, ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) {
    throw new TargetValidationError(`${key} has unknown field(s): ${extra.join(', ')}`);
  }
  if (typeof unit !== 'string' || !units.includes(unit as U)) {
    throw new TargetValidationError(`${key}.unit must be one of ${units.join(', ')}`);
  }
  return { value: requireNonNegative(`${key}.value`, value), unit: unit as U };
}

/**
 * Validate an untrusted weekly-targets payload. Unknown keys, non-finite or
 * negative numbers, and unrecognised units are rejected loudly rather than
 * silently dropped — a target the user believes they set but that never
 * reached the DB would show as unmet forever.
 *
 * Keys explicitly set to null/undefined are treated as "unset" and omitted,
 * so the editor can clear a target without sending a sentinel.
 */
export function parseWeeklyTargets(raw: unknown): WeeklyTargets {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TargetValidationError('weeklyTargets must be an object');
  }

  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(
    k => !(WEEKLY_TARGET_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length) {
    throw new TargetValidationError(`Unknown weekly target(s): ${unknown.join(', ')}`);
  }

  const out: WeeklyTargets = {};
  for (const key of SCALAR_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    out[key] = requireNonNegative(key, value);
  }
  for (const [key, units] of Object.entries(QUANTITY_KEYS)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (key === 'vert') {
      out.vert = parseQuantityTarget(key, value, units as readonly ElevationUnit[]);
    } else {
      out.distance = parseQuantityTarget(key, value, units as readonly DistanceUnit[]);
    }
  }
  return out;
}

/** The numeric side of a target, unit-agnostic — for attainment math. */
export function targetValue(targets: WeeklyTargets, key: WeeklyTargetKey): number | undefined {
  const raw = targets[key];
  if (raw === undefined) return undefined;
  return typeof raw === 'number' ? raw : raw.value;
}

/** The unit a target names, or '' for bare counts and minutes. */
export function targetUnit(targets: WeeklyTargets, key: WeeklyTargetKey): string {
  const raw = targets[key];
  if (raw === undefined || typeof raw === 'number') return TARGET_META[key].unit;
  return raw.unit;
}
