import { format, parseISO, startOfWeek, subDays, subWeeks } from 'date-fns';
import { zoneBounds, zoneOf } from '../analytics/hrZones.js';
import { classifySet } from '../tracking/records.js';
import { minutesForBareDuration } from '../review/stats.js';
import type {
  ActivityInput,
  HrvSummary,
  LoadSummary,
  PhysiologyInputs,
  PhysiologySummary,
  SetLogInput,
  WeekTonnage,
  WeekZoneMinutes,
  ZoneMethod,
  ZoneMinutes,
} from './types.js';

// ─── computePhysiology ────────────────────────────────────────────────────────
// Pure rollup of five Monday-start weeks (four completed + the current one)
// into the numbers the coach prompt cites. The same principle as the review
// stats: every number the model sees is computed here, it never derives one.
//
// Zone model: src/lib/analytics/hrZones.ts is the only definition of Z1–Z5
// (Friel LTHR bands, else %-of-max). This module classifies with it and
// never defines a boundary of its own.

const WEEK_OPTS = { weekStartsOn: 1 } as const;
const ISO = 'yyyy-MM-dd';
const ZERO: ZoneMinutes = [0, 0, 0, 0, 0];

function weekStartOf(date: string): string {
  return format(startOfWeek(parseISO(date), WEEK_OPTS), ISO);
}

function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const round = (n: number, places = 0): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const eventKey = (eventId: string, eventDate: string) => `${eventId}|${eventDate}`;

// ─── Provider zone data ───────────────────────────────────────────────────────

/** Five numbers out of the shapes a provider plausibly sends, or null. */
function fiveNumbers(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    if (raw.length !== 5) return null;
    if (raw.every(v => typeof v === 'number')) {
      return (raw as number[]).every(Number.isFinite) ? (raw as number[]) : null;
    }
    // [{ zone: 1, seconds: 600 }, …] — any numeric field beside the index.
    const values = raw.map(entry => {
      if (typeof entry !== 'object' || entry === null) return null;
      const fields = Object.entries(entry as Record<string, unknown>)
        .filter(([k, v]) => typeof v === 'number' && Number.isFinite(v) && !/^(zone|index|id|z)$/i.test(k));
      return fields.length === 1 ? (fields[0][1] as number) : null;
    });
    return values.every((v): v is number => v !== null) ? values : null;
  }
  if (typeof raw === 'object' && raw !== null) {
    // { z1: …, z2: … } / { zone1: … } / { "1": … }
    const byZone = new Map<number, number>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const m = k.match(/^(?:z|zone)?\s*_?([1-5])$/i);
      if (m && typeof v === 'number' && Number.isFinite(v)) byZone.set(Number(m[1]), v);
    }
    if (byZone.size !== 5) return null;
    return [1, 2, 3, 4, 5].map(z => byZone.get(z)!);
  }
  return null;
}

/**
 * Zone minutes from summary.hrZones. The unit is not pinned anywhere (the
 * provider passes the field through raw), so instead of assuming one the
 * total is checked against the activity's own duration: a sum within 25% of
 * durationSec is seconds, ×60 within 25% is minutes, ≈100 is percent. A
 * reading that agrees with none of those, or an activity with no duration
 * to check against, is discarded and the average-HR fallback takes over —
 * a wrong unit would misstate Z2 volume by 60×, which is worse than coarse.
 */
export function parseHrZones(raw: unknown, durationSec: number | null): ZoneMinutes | null {
  const values = fiveNumbers(raw);
  if (!values || values.some(v => v < 0)) return null;
  if (!finite(durationSec) || durationSec <= 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) / b <= tolerance;
  let minutes: number[];
  if (near(sum, durationSec, 0.25)) minutes = values.map(v => v / 60);
  else if (near(sum * 60, durationSec, 0.25)) minutes = values;
  else if (near(sum, 100, 0.05)) minutes = values.map(v => (v / 100) * (durationSec / 60));
  else return null;
  return minutes as ZoneMinutes;
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function computeZoneMinutes(
  inputs: PhysiologyInputs,
  weekStarts: string[],
  inWindow: (date: string) => boolean,
): { byWeek: WeekZoneMinutes[]; method: ZoneMethod } | null {
  const bounds = zoneBounds({ thresholdHr: inputs.thresholdHr, maxHr: inputs.maxHr });
  const perWeek = new Map<string, ZoneMinutes>();
  const covered = new Set<string>();
  let deviceSessions = 0;
  let avgHrSessions = 0;

  const add = (date: string, minutes: ZoneMinutes) => {
    const week = weekStartOf(date);
    const current = perWeek.get(week) ?? [...ZERO] as ZoneMinutes;
    minutes.forEach((m, i) => { current[i] += m; });
    perWeek.set(week, current);
  };
  const fromAverage = (avgHr: number | null, minutes: number | null): ZoneMinutes | null => {
    if (!bounds || !finite(avgHr) || avgHr <= 0 || !finite(minutes) || minutes <= 0) return null;
    const out = [...ZERO] as ZoneMinutes;
    out[zoneOf(avgHr, bounds)] = minutes;
    return out;
  };

  for (const a of inputs.activities) {
    if (!inWindow(a.eventDate)) continue;
    const device = parseHrZones(a.hrZones, a.durationSec);
    if (device) {
      add(a.eventDate, device);
      deviceSessions += 1;
      covered.add(eventKey(a.eventId, a.eventDate));
      continue;
    }
    const estimated = fromAverage(a.avgHr, finite(a.durationSec) ? a.durationSec / 60 : null);
    if (estimated) {
      add(a.eventDate, estimated);
      avgHrSessions += 1;
      covered.add(eventKey(a.eventId, a.eventDate));
    }
  }
  // Cardio logs fill in for sessions no stream covered. A synced activity
  // writes both rows for the same event, so the key check stops the log from
  // counting the same session twice.
  for (const c of inputs.cardioLogs) {
    if (!inWindow(c.eventDate) || covered.has(eventKey(c.eventId, c.eventDate))) continue;
    const estimated = fromAverage(c.avgHeartRate, c.durationMinutes);
    if (estimated) {
      add(c.eventDate, estimated);
      avgHrSessions += 1;
    }
  }

  if (perWeek.size === 0) return null;
  const byWeek = weekStarts.map(weekStart => {
    const minutes = perWeek.get(weekStart);
    return { weekStart, minutes: minutes ? minutes.map(m => round(m)) as ZoneMinutes : null };
  });
  const method: ZoneMethod = deviceSessions && avgHrSessions ? 'mixed' : deviceSessions ? 'device' : 'avgHr';
  return { byWeek, method };
}

function computeLoad(inputs: PhysiologyInputs, inWindow: (date: string) => boolean): LoadSummary | null {
  const today = parseISO(inputs.today);
  const acuteStart = format(subDays(today, 6), ISO);
  const chronicStart = format(subDays(today, 27), ISO);

  const withLoad = inputs.activities.filter(a => inWindow(a.eventDate) && finite(a.trainingLoad) && a.trainingLoad! >= 0);
  let samples: Array<{ date: string; value: number }>;
  let source: LoadSummary['source'];
  if (withLoad.length > 0) {
    source = 'trainingLoad';
    samples = withLoad.map(a => ({ date: a.eventDate, value: a.trainingLoad! }));
  } else {
    source = 'cardioMinutes';
    samples = inputs.cardioLogs
      .filter(c => inWindow(c.eventDate) && finite(c.durationMinutes) && c.durationMinutes! > 0)
      .map(c => ({ date: c.eventDate, value: c.durationMinutes! }));
  }
  if (samples.length === 0) return null;

  const acute = samples.filter(s => s.date >= acuteStart).reduce((sum, s) => sum + s.value, 0);
  const chronicTotal = samples.filter(s => s.date >= chronicStart).reduce((sum, s) => sum + s.value, 0);
  const chronic = chronicTotal / 4;
  return {
    source,
    acute7d: round(acute),
    chronicWeeklyAvg28d: round(chronic),
    ratio: chronic > 0 ? round(acute / chronic, 2) : null,
  };
}

function computeTonnage(setLogs: SetLogInput[], weekStarts: string[], inWindow: (date: string) => boolean): WeekTonnage[] | null {
  // Same rule as the review email's tonnage (computeStrengthStats): logged
  // weighted sets only, weight × reps, autofilled zero-fills skipped.
  const perWeek = new Map<string, number>();
  for (const row of setLogs) {
    if (row.isAutofilled || !inWindow(row.eventDate)) continue;
    const set = classifySet(row.actualWeight, row.actualReps, minutesForBareDuration(row.actualDuration));
    if (set?.kind !== 'oneRM') continue;
    const week = weekStartOf(row.eventDate);
    perWeek.set(week, (perWeek.get(week) ?? 0) + set.weight * set.reps);
  }
  if (perWeek.size === 0) return null;
  return weekStarts.map(weekStart => {
    const tonnage = perWeek.get(weekStart);
    return { weekStart, tonnageLb: tonnage === undefined ? null : round(tonnage) };
  });
}

function computeHrv(activities: ActivityInput[], todayIso: string, inWindow: (date: string) => boolean): HrvSummary | null {
  const today = parseISO(todayIso);
  const sevenStart = format(subDays(today, 6), ISO);
  const monthStart = format(subDays(today, 27), ISO);
  const readings = activities.filter(a => inWindow(a.eventDate) && finite(a.hrv) && a.hrv! > 0 && a.eventDate >= monthStart);
  if (readings.length === 0) return null;
  const mean = (rows: ActivityInput[]) => round(rows.reduce((sum, a) => sum + a.hrv!, 0) / rows.length);
  const recent = readings.filter(a => a.eventDate >= sevenStart);
  return { mean7d: recent.length ? mean(recent) : null, mean28d: mean(readings) };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function computePhysiology(inputs: PhysiologyInputs): PhysiologySummary {
  const today = parseISO(inputs.today);
  const thisWeek = startOfWeek(today, WEEK_OPTS);
  const weekStarts = [4, 3, 2, 1, 0].map(n => format(subWeeks(thisWeek, n), ISO));
  const windowStart = weekStarts[0];
  // Dates past today are ignored even inside the current week: a log filed
  // ahead of time is a plan, not a measurement.
  const inWindow = (date: string) => date >= windowStart && date <= inputs.today;

  const summary: PhysiologySummary = { weekStarts, today: inputs.today };
  const zones = computeZoneMinutes(inputs, weekStarts, inWindow);
  if (zones) {
    summary.zoneMinutesByWeek = zones.byWeek;
    summary.zoneMethod = zones.method;
  }
  const load = computeLoad(inputs, inWindow);
  if (load) summary.load = load;
  const tonnage = computeTonnage(inputs.setLogs, weekStarts, inWindow);
  if (tonnage) summary.tonnageByWeek = tonnage;
  const hrv = computeHrv(inputs.activities, inputs.today, inWindow);
  if (hrv) summary.hrv = hrv;
  return summary;
}

/**
 * First day of the window — the Monday four weeks before this week's Monday.
 * The server fetch queries from here so it reads exactly what computePhysiology
 * buckets, and nothing more.
 */
export function physiologyWindowStart(todayIso: string): string {
  return format(startOfWeek(subWeeks(parseISO(todayIso), 4), WEEK_OPTS), ISO);
}
