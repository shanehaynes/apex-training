import type { ProviderActivity } from '../coros/client.js';
import type { ActivitySport, ApexWorkoutType, SportMapping } from '../coros/mapSport.js';
import { downsample, MAX_STREAM_POINTS } from '../streams.js';

// Apple Health workouts, as the phone posts them to /api/provider-sync (W16
// M2b). The phone is the provider: there is no token and no fetch — the body
// IS the activity list, so everything here is untrusted input with bounds.
//
// The workout type arrives as the integer `HKWorkoutActivityType` and is
// mapped on that integer, never through the COROS label mapper: its /trad/
// rule sends "Traditional Strength Training" to outdoor-climbing.

/** The app's own bundle id. Apex writes finished tracker sessions to Health
 *  (M1); reading them back would import every workout twice. */
export const APEX_BUNDLE_ID = 'com.shanehaynes.apextraining';

/** Activities per request, the contract's 1..100. */
export const MAX_APPLE_ACTIVITIES = 100;

const MAX_DURATION_SEC = 24 * 3600;
const MAX_TEXT = 200;
const MAX_EXTRAS_BYTES = 8_000;

interface AppleType {
  label: string;
  type: ApexWorkoutType;
  sport: ActivitySport;
}

// HKWorkoutActivityType raw values, read from the iOS 26.5 SDK's HealthKit
// (`HKWorkoutActivityType.rawValue` printed on a Mac, 2026-10-17). Apex's
// workout types are few (phase17), so most sports collapse into cardio with
// the sport kept in the title; the analytics bucket (phase37) is set only
// where it is unambiguous.
export const APPLE_ACTIVITY_TYPES: Readonly<Record<number, AppleType>> = {
  1: { label: 'American Football', type: 'cardio', sport: null },
  2: { label: 'Archery', type: 'cardio', sport: null },
  4: { label: 'Badminton', type: 'cardio', sport: null },
  5: { label: 'Baseball', type: 'cardio', sport: null },
  6: { label: 'Basketball', type: 'cardio', sport: null },
  7: { label: 'Bowling', type: 'cardio', sport: null },
  8: { label: 'Boxing', type: 'cardio', sport: null },
  9: { label: 'Climb', type: 'climbing', sport: 'climbing' },
  10: { label: 'Cricket', type: 'cardio', sport: null },
  11: { label: 'Cross Training', type: 'weights', sport: null },
  12: { label: 'Curling', type: 'cardio', sport: null },
  13: { label: 'Ride', type: 'cardio', sport: 'biking' },
  16: { label: 'Elliptical', type: 'cardio', sport: null },
  17: { label: 'Equestrian', type: 'cardio', sport: null },
  18: { label: 'Fencing', type: 'cardio', sport: null },
  19: { label: 'Fishing', type: 'cardio', sport: null },
  20: { label: 'Functional Strength', type: 'weights', sport: null },
  21: { label: 'Golf', type: 'cardio', sport: null },
  22: { label: 'Gymnastics', type: 'cardio', sport: null },
  23: { label: 'Handball', type: 'cardio', sport: null },
  24: { label: 'Hike', type: 'cardio', sport: null },
  25: { label: 'Hockey', type: 'cardio', sport: null },
  26: { label: 'Hunting', type: 'cardio', sport: null },
  27: { label: 'Lacrosse', type: 'cardio', sport: null },
  28: { label: 'Martial Arts', type: 'cardio', sport: null },
  29: { label: 'Mind and Body', type: 'stretching', sport: null },
  31: { label: 'Paddle', type: 'cardio', sport: null },
  32: { label: 'Play', type: 'cardio', sport: null },
  33: { label: 'Recovery', type: 'stretching', sport: null },
  34: { label: 'Racquetball', type: 'cardio', sport: null },
  35: { label: 'Row', type: 'cardio', sport: null },
  36: { label: 'Rugby', type: 'cardio', sport: null },
  37: { label: 'Run', type: 'cardio', sport: 'running' },
  38: { label: 'Sailing', type: 'cardio', sport: null },
  39: { label: 'Skating', type: 'cardio', sport: null },
  40: { label: 'Snow Sports', type: 'cardio', sport: null },
  41: { label: 'Soccer', type: 'cardio', sport: null },
  42: { label: 'Softball', type: 'cardio', sport: null },
  43: { label: 'Squash', type: 'cardio', sport: null },
  44: { label: 'Stair Climbing', type: 'cardio', sport: null },
  45: { label: 'Surf', type: 'cardio', sport: null },
  46: { label: 'Swim', type: 'cardio', sport: 'swimming' },
  47: { label: 'Table Tennis', type: 'cardio', sport: null },
  48: { label: 'Tennis', type: 'cardio', sport: null },
  49: { label: 'Track and Field', type: 'cardio', sport: null },
  50: { label: 'Strength', type: 'weights', sport: null },
  51: { label: 'Volleyball', type: 'cardio', sport: null },
  52: { label: 'Walk', type: 'cardio', sport: null },
  53: { label: 'Water Fitness', type: 'cardio', sport: null },
  54: { label: 'Water Polo', type: 'cardio', sport: null },
  55: { label: 'Water Sports', type: 'cardio', sport: null },
  56: { label: 'Wrestling', type: 'cardio', sport: null },
  57: { label: 'Yoga', type: 'yoga', sport: null },
  58: { label: 'Barre', type: 'stretching', sport: null },
  59: { label: 'Core Training', type: 'weights', sport: null },
  60: { label: 'XC Ski', type: 'cardio', sport: null },
  61: { label: 'Ski', type: 'cardio', sport: null },
  62: { label: 'Flexibility', type: 'stretching', sport: null },
  63: { label: 'HIIT', type: 'cardio', sport: null },
  64: { label: 'Jump Rope', type: 'cardio', sport: null },
  65: { label: 'Kickboxing', type: 'cardio', sport: null },
  66: { label: 'Pilates', type: 'stretching', sport: null },
  67: { label: 'Snowboard', type: 'cardio', sport: null },
  68: { label: 'Stairs', type: 'cardio', sport: null },
  69: { label: 'Step Training', type: 'cardio', sport: null },
  70: { label: 'Wheelchair Walk', type: 'cardio', sport: null },
  71: { label: 'Wheelchair Run', type: 'cardio', sport: null },
  72: { label: 'Tai Chi', type: 'stretching', sport: null },
  73: { label: 'Mixed Cardio', type: 'cardio', sport: null },
  74: { label: 'Hand Cycling', type: 'cardio', sport: 'biking' },
  75: { label: 'Disc Sports', type: 'cardio', sport: null },
  76: { label: 'Fitness Gaming', type: 'cardio', sport: null },
  77: { label: 'Cardio Dance', type: 'cardio', sport: null },
  78: { label: 'Social Dance', type: 'cardio', sport: null },
  79: { label: 'Pickleball', type: 'cardio', sport: null },
  80: { label: 'Cooldown', type: 'stretching', sport: null },
  82: { label: 'Triathlon', type: 'cardio', sport: null },
  83: { label: 'Transition', type: 'cardio', sport: null },
  84: { label: 'Diving', type: 'cardio', sport: null },
  3000: { label: 'Workout', type: 'cardio', sport: null },
};

/** `HKWorkoutActivityType` → Apex type, title and sport. An unknown (newer)
 *  type imports as cardio titled "Workout", so a new watch mode never blocks
 *  an import. */
export function mapAppleActivityType(activityType: number | string | null | undefined): SportMapping {
  const known = typeof activityType === 'number' ? APPLE_ACTIVITY_TYPES[activityType] : undefined;
  return known ? { type: known.type, label: known.label, sport: known.sport } : { type: 'cardio', label: 'Workout', sport: null };
}

// ─── The body parser ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown, min: number, max: number): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  return v;
}

function text(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function isoInstant(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseHrStream(raw: unknown): [number, number][] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  const points: [number, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [sec, bpm] = p;
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null;
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 250) return null;
    points.push([sec, bpm]);
  }
  // The phone thins to the cap; a longer series is thinned here rather than
  // refused, the way the COROS path treats a FIT file.
  return points.length > MAX_STREAM_POINTS ? downsample(points) : points;
}

/** One AppleActivity → the normalized ProviderActivity, or null when any
 *  field is malformed or out of bounds. */
export function parseAppleActivity(raw: unknown): ProviderActivity | null {
  if (!isRecord(raw)) return null;
  const activityId = text(raw.activityId, 100);
  const activityType = raw.activityType;
  if (!activityId || typeof activityType !== 'number' || !Number.isInteger(activityType) || activityType < 0) return null;
  const startUtc = isoInstant(raw.startUtc);
  const endUtc = isoInstant(raw.endUtc);
  if (!startUtc || !endUtc || Date.parse(endUtc) < Date.parse(startUtc)) return null;
  const durationSec = finite(raw.durationSec, 1, MAX_DURATION_SEC);
  if (typeof durationSec !== 'number') return null;

  const bounded = {
    distanceMeters: finite(raw.distanceMeters, 0, 1_000_000),
    elevationGainMeters: finite(raw.elevationGainMeters, 0, 20_000),
    avgHr: finite(raw.avgHr, 20, 250),
    maxHr: finite(raw.maxHr, 20, 250),
    calories: finite(raw.calories, 0, 50_000),
  };
  if (Object.values(bounded).some(v => v === null)) return null;
  // Every null was refused above.
  const optional = bounded as { [K in keyof typeof bounded]: number | undefined };

  const sourceBundleId = raw.sourceBundleId === undefined ? null : text(raw.sourceBundleId);
  const sourceName = raw.sourceName === undefined ? null : text(raw.sourceName);
  const activityName = raw.activityName === undefined ? null : text(raw.activityName);
  if ((raw.sourceBundleId !== undefined && !sourceBundleId) || (raw.sourceName !== undefined && !sourceName)
      || (raw.activityName !== undefined && !activityName)) return null;

  let extras: Record<string, unknown> = {};
  if (raw.summaryExtras !== undefined) {
    if (!isRecord(raw.summaryExtras) || JSON.stringify(raw.summaryExtras).length > MAX_EXTRAS_BYTES) return null;
    extras = raw.summaryExtras;
  }

  let streams: ProviderActivity['streams'];
  if (raw.streams !== undefined && raw.streams !== null) {
    if (!isRecord(raw.streams)) return null;
    const hr = parseHrStream(raw.streams.hr);
    if (hr === null) return null;
    if (hr && hr.length > 0) streams = { hr };
  }

  return {
    provider: 'apple',
    activityId,
    sport: activityType,
    startUtc,
    durationSec,
    ...(optional.distanceMeters !== undefined ? { distanceMeters: optional.distanceMeters } : {}),
    ...(optional.elevationGainMeters !== undefined ? { elevationGainMeters: optional.elevationGainMeters } : {}),
    ...(optional.avgHr !== undefined ? { avgHr: optional.avgHr } : {}),
    ...(optional.maxHr !== undefined ? { maxHr: optional.maxHr } : {}),
    ...(optional.calories !== undefined ? { calories: optional.calories } : {}),
    // What the phone said about the workout, kept for the stream summary and
    // for the own-app and dedup rules (sync.ts).
    summaryExtras: {
      ...extras,
      endUtc,
      ...(activityName ? { activityName } : {}),
      ...(sourceName ? { sourceName } : {}),
      ...(sourceBundleId ? { sourceBundleId } : {}),
    },
    ...(streams ? { streams } : {}),
  };
}

/** The body's `activities`: 1..100 well-formed, unique by id; null otherwise. */
export function parseAppleActivities(raw: unknown): ProviderActivity[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_APPLE_ACTIVITIES) return null;
  const out: ProviderActivity[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const activity = parseAppleActivity(item);
    if (!activity || seen.has(activity.activityId)) return null;
    seen.add(activity.activityId);
    out.push(activity);
  }
  return out;
}

/** The workout came from Apex itself (M1 wrote it to Health). */
export function isOwnAppActivity(activity: ProviderActivity): boolean {
  return activity.summaryExtras.sourceBundleId === APEX_BUNDLE_ID;
}
