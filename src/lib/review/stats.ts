import { differenceInCalendarDays, format, parseISO, startOfISOWeek } from 'date-fns';
import type { CardioLogRow, CompletionRow, SetLogRow, WorkoutSessionRow } from '../db/types.js';
import { classifySet, parseQuantity } from '../tracking/records.js';
import {
  getIsoMonth,
  isoWeeksInYear,
  monthBoundaries,
  periodLabel,
  weeksInMonth,
  yearBoundaries,
} from './isoMonth.js';
import type {
  CardioStats,
  DatedPersonalRecord,
  MonthLite,
  PeriodType,
  QuantityHighlight,
  ReviewInputs,
  ReviewPeriod,
  ReviewStats,
  StrengthStats,
  YearlyStats,
} from './types.js';

// ─── Review stats aggregation ─────────────────────────────────────────────────
// Pure, deterministic rollups over the tracking logs. Every number in a
// review email is computed here — the AI narrates these facts, it never
// derives them (see AGENTS.md). Parsing of free-text tracker values reuses
// src/lib/tracking/records.ts so review numbers match what the tracker shows.

export function buildReviewPeriod(periodType: PeriodType, isoYear: number, monthIndex?: number): ReviewPeriod {
  if (periodType === 'month') {
    if (monthIndex === undefined) throw new Error('Month reviews need a monthIndex');
    return {
      ...monthBoundaries(isoYear, monthIndex),
      periodType,
      isoYear,
      monthIndex,
      label: periodLabel({ isoYear, month: monthIndex }),
      weeksInPeriod: weeksInMonth(isoYear, monthIndex),
    };
  }
  return {
    ...yearBoundaries(isoYear),
    periodType,
    isoYear,
    label: periodLabel(isoYear),
    weeksInPeriod: isoWeeksInYear(isoYear),
  };
}

const inPeriod = (date: string, period: ReviewPeriod) =>
  date >= period.startDate && date < period.endDateExclusive;

// ─── PR detection: single ordered scan ────────────────────────────────────────
// The tracker computes PRs per session against all prior history
// (computeSessionPRs); a review period needs the same semantics across many
// sessions, so instead of reconstructing UI-shaped session groups we walk the
// full log history once in date order, keeping a running best per exercise
// (and per unit for cardio). A day that beats the running best inside the
// period is a PR — compared against the best BEFORE that day, so several
// sets in one day yield at most one PR per exercise, exactly like the
// tracker. First-ever logs are never PRs: there is nothing to beat.

interface BestLift { oneRM: number; weight: number; reps: number; date: string }
interface BestValue { value: number; date: string }

function groupByDateAscending<T extends { event_date: string }>(rows: T[]): Array<[string, T[]]> {
  const byDate = new Map<string, T[]>();
  for (const row of rows) {
    const group = byDate.get(row.event_date);
    if (group) group.push(row);
    else byDate.set(row.event_date, [row]);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function computePeriodPRs(
  setLogs: SetLogRow[],
  cardioLogs: CardioLogRow[],
  period: ReviewPeriod,
): DatedPersonalRecord[] {
  const prs: DatedPersonalRecord[] = [];

  const bestLift = new Map<string, BestLift>();
  const bestDuration = new Map<string, BestValue>();
  const bestReps = new Map<string, BestValue>();

  for (const [date, rows] of groupByDateAscending(setLogs)) {
    const dayLift = new Map<string, BestLift>();
    const dayDuration = new Map<string, BestValue>();
    const dayReps = new Map<string, BestValue>();

    for (const row of rows) {
      if (row.is_autofilled) continue;
      const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
      if (!set) continue;
      const name = row.exercise_name;
      if (set.kind === 'oneRM') {
        const current = dayLift.get(name);
        if (!current || set.oneRM > current.oneRM) {
          dayLift.set(name, { oneRM: set.oneRM, weight: set.weight, reps: set.reps, date });
        }
      } else if (set.kind === 'duration') {
        const current = dayDuration.get(name);
        if (!current || set.seconds > current.value) dayDuration.set(name, { value: set.seconds, date });
      } else {
        const current = dayReps.get(name);
        if (!current || set.reps > current.value) dayReps.set(name, { value: set.reps, date });
      }
    }

    for (const [name, day] of dayLift) {
      const prior = bestLift.get(name);
      if (prior && day.oneRM > prior.oneRM && inPeriod(date, period)) {
        prs.push({
          kind: 'oneRM',
          exerciseName: name,
          estimatedOneRM: day.oneRM,
          weight: day.weight,
          reps: day.reps,
          previousOneRM: prior.oneRM,
          previousDate: prior.date,
          date,
        });
      }
      if (!prior || day.oneRM > prior.oneRM) bestLift.set(name, day);
    }
    for (const [name, day] of dayDuration) {
      const prior = bestDuration.get(name);
      if (prior && day.value > prior.value && inPeriod(date, period)) {
        prs.push({
          kind: 'duration',
          exerciseName: name,
          seconds: day.value,
          previousSeconds: prior.value,
          previousDate: prior.date,
          date,
        });
      }
      if (!prior || day.value > prior.value) bestDuration.set(name, day);
    }
    for (const [name, day] of dayReps) {
      const prior = bestReps.get(name);
      if (prior && day.value > prior.value && inPeriod(date, period)) {
        prs.push({
          kind: 'reps',
          exerciseName: name,
          reps: day.value,
          previousReps: prior.value,
          previousDate: prior.date,
          date,
        });
      }
      if (!prior || day.value > prior.value) bestReps.set(name, day);
    }
  }

  // Cardio: per exercise AND per normalized unit — "5 mi" never races "8 km".
  const bestQuantity = new Map<string, BestValue>();
  const quantityKey = (name: string, kind: string, unit: string) => `${name}|${kind}|${unit}`;

  for (const [date, rows] of groupByDateAscending(cardioLogs)) {
    const dayBest = new Map<string, { kind: 'distance' | 'elevation'; name: string; unit: string; value: number }>();
    for (const row of rows) {
      if (row.is_autofilled) continue;
      const candidates: Array<{ kind: 'distance' | 'elevation'; raw: string | null }> = [
        { kind: 'distance', raw: row.distance },
        { kind: 'elevation', raw: row.elevation_gain },
      ];
      for (const { kind, raw } of candidates) {
        const parsed = parseQuantity(raw);
        if (!parsed) continue;
        const key = quantityKey(row.exercise_name, kind, parsed.unit);
        const current = dayBest.get(key);
        if (!current || parsed.value > current.value) {
          dayBest.set(key, { kind, name: row.exercise_name, unit: parsed.unit, value: parsed.value });
        }
      }
    }
    for (const [key, day] of dayBest) {
      const prior = bestQuantity.get(key);
      if (prior && day.value > prior.value && inPeriod(date, period)) {
        prs.push({
          kind: day.kind,
          exerciseName: day.name,
          value: day.value,
          unit: day.unit,
          previousValue: prior.value,
          previousDate: prior.date,
          date,
        });
      }
      if (!prior || day.value > prior.value) bestQuantity.set(key, { value: day.value, date });
    }
  }

  return prs.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.exerciseName.localeCompare(b.exerciseName),
  );
}

// ─── Totals ───────────────────────────────────────────────────────────────────

const sessionKey = (eventId: string, eventDate: string) => `${eventId}|${eventDate}`;

/** Tracked session seconds win over the completion's estimate. */
function durationMinutesFor(completion: CompletionRow, sessionSeconds: Map<string, number>): number {
  const seconds = sessionSeconds.get(sessionKey(completion.event_id, completion.event_date));
  if (seconds != null) return seconds / 60;
  return completion.duration_minutes ?? 0;
}

function sessionSecondsMap(sessions: WorkoutSessionRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of sessions) {
    if (s.total_duration_seconds != null) map.set(sessionKey(s.event_id, s.event_date), s.total_duration_seconds);
  }
  return map;
}

function longestStreak(dates: string[]): number {
  const sorted = [...new Set(dates)].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const date of sorted) {
    run = prev && differenceInCalendarDays(parseISO(date), parseISO(prev)) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = date;
  }
  return longest;
}

/**
 * The single best effort across mixed units: compared within each unit, then
 * taken from whichever unit has the most logged entries (cross-unit values
 * are incomparable without conversion, which the repo never does).
 */
function dominantHighlight(entries: QuantityHighlight[]): QuantityHighlight | null {
  if (entries.length === 0) return null;
  const countByUnit = new Map<string, number>();
  for (const e of entries) countByUnit.set(e.unit, (countByUnit.get(e.unit) ?? 0) + 1);
  const dominantUnit = [...countByUnit.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return entries
    .filter(e => e.unit === dominantUnit)
    .reduce((best, e) => (e.value > best.value ? e : best));
}

function computeCardioStats(cardioLogs: CardioLogRow[], period: ReviewPeriod): CardioStats {
  const distanceByUnit: Record<string, number> = {};
  const elevationByUnit: Record<string, number> = {};
  const distances: QuantityHighlight[] = [];
  const climbs: QuantityHighlight[] = [];

  for (const row of cardioLogs) {
    if (row.is_autofilled || !inPeriod(row.event_date, period)) continue;
    const dist = parseQuantity(row.distance);
    if (dist) {
      distanceByUnit[dist.unit] = (distanceByUnit[dist.unit] ?? 0) + dist.value;
      distances.push({ value: dist.value, unit: dist.unit, exerciseName: row.exercise_name, date: row.event_date });
    }
    const elev = parseQuantity(row.elevation_gain);
    if (elev) {
      elevationByUnit[elev.unit] = (elevationByUnit[elev.unit] ?? 0) + elev.value;
      climbs.push({ value: elev.value, unit: elev.unit, exerciseName: row.exercise_name, date: row.event_date });
    }
  }

  return {
    distanceByUnit,
    elevationByUnit,
    longestDistance: dominantHighlight(distances),
    biggestClimb: dominantHighlight(climbs),
  };
}

function computeStrengthStats(setLogs: SetLogRow[], period: ReviewPeriod): StrengthStats {
  let tonnage = 0;
  let totalSets = 0;
  let totalReps = 0;
  let heaviestSet: StrengthStats['heaviestSet'] = null;
  const setsByExercise = new Map<string, number>();

  for (const row of setLogs) {
    if (row.is_autofilled || !inPeriod(row.event_date, period)) continue;
    const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
    if (!set) continue;
    totalSets += 1;
    setsByExercise.set(row.exercise_name, (setsByExercise.get(row.exercise_name) ?? 0) + 1);
    if (set.kind === 'oneRM') {
      tonnage += set.weight * set.reps;
      totalReps += set.reps;
      if (!heaviestSet || set.weight > heaviestSet.weight || (set.weight === heaviestSet.weight && set.reps > heaviestSet.reps)) {
        heaviestSet = { weight: set.weight, reps: set.reps, exerciseName: row.exercise_name, date: row.event_date };
      }
    } else if (set.kind === 'reps') {
      totalReps += set.reps;
    }
  }

  const topExercises = [...setsByExercise.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([exerciseName, sets]) => ({ exerciseName, sets }));

  return { tonnage: Math.round(tonnage), totalSets, totalReps, heaviestSet, topExercises };
}

export function computeReviewStats(inputs: ReviewInputs): ReviewStats {
  const { period } = inputs;
  const completions = inputs.completions.filter(c => c.is_completed && inPeriod(c.event_date, period));
  const sessions = inputs.sessions.filter(s => inPeriod(s.event_date, period));
  const seconds = sessionSecondsMap(sessions);

  const sessionsByType: Record<string, number> = {};
  let totalDurationMinutes = 0;
  const activeDates: string[] = [];
  const sessionsByWeek = new Map<string, number>();

  for (const completion of completions) {
    sessionsByType[completion.event_type] = (sessionsByType[completion.event_type] ?? 0) + 1;
    totalDurationMinutes += durationMinutesFor(completion, seconds);
    activeDates.push(completion.event_date);
    const weekStart = format(startOfISOWeek(parseISO(completion.event_date)), 'yyyy-MM-dd');
    sessionsByWeek.set(weekStart, (sessionsByWeek.get(weekStart) ?? 0) + 1);
  }

  const mostActiveWeek = [...sessionsByWeek.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, count]) => ({ weekStart, sessions: count }))[0] ?? null;

  // Longest session: tracked sessions win (real stopwatch time); fall back to
  // completion estimates when nothing was tracked. Titles live on completions.
  const titleByKey = new Map(completions.map(c => [sessionKey(c.event_id, c.event_date), c.event_title]));
  let longestSession: ReviewStats['notable']['longestSession'] = null;
  for (const s of sessions) {
    if (s.total_duration_seconds == null) continue;
    const minutes = s.total_duration_seconds / 60;
    if (!longestSession || minutes > longestSession.minutes) {
      longestSession = {
        minutes: Math.round(minutes),
        date: s.event_date,
        title: titleByKey.get(sessionKey(s.event_id, s.event_date)) ?? 'Workout',
      };
    }
  }
  if (!longestSession) {
    for (const c of completions) {
      if (c.duration_minutes == null) continue;
      if (!longestSession || c.duration_minutes > longestSession.minutes) {
        longestSession = { minutes: c.duration_minutes, date: c.event_date, title: c.event_title };
      }
    }
  }

  const prs = computePeriodPRs(inputs.setLogs, inputs.cardioLogs, period);
  const prCountsByKind: Record<string, number> = {};
  for (const pr of prs) prCountsByKind[pr.kind] = (prCountsByKind[pr.kind] ?? 0) + 1;

  return {
    period,
    totals: {
      sessionsCompleted: completions.length,
      sessionsByType,
      totalDurationMinutes: Math.round(totalDurationMinutes),
      activeDays: new Set(activeDates).size,
      weeksActive: sessionsByWeek.size,
    },
    cardio: computeCardioStats(inputs.cardioLogs, period),
    strength: computeStrengthStats(inputs.setLogs, period),
    prs,
    prCountsByKind,
    streaks: { longestActiveDayStreak: longestStreak(activeDates), mostActiveWeek },
    notable: { longestSession },
  };
}

// ─── Yearly retrospective ─────────────────────────────────────────────────────

function relativeImprovement(pr: DatedPersonalRecord): number {
  switch (pr.kind) {
    case 'oneRM':
      return pr.previousOneRM > 0 ? (pr.estimatedOneRM - pr.previousOneRM) / pr.previousOneRM : 0;
    case 'duration':
      return pr.previousSeconds > 0 ? (pr.seconds - pr.previousSeconds) / pr.previousSeconds : 0;
    case 'reps':
      return pr.previousReps > 0 ? (pr.reps - pr.previousReps) / pr.previousReps : 0;
    case 'distance':
    case 'elevation':
      return pr.previousValue > 0 ? (pr.value - pr.previousValue) / pr.previousValue : 0;
  }
}

function monthRangeLabel(isoYear: number, month: number): string {
  const { startDate, endDateExclusive } = monthBoundaries(isoYear, month);
  const end = parseISO(endDateExclusive);
  end.setDate(end.getDate() - 1);
  return `${format(parseISO(startDate), 'MMM d')} – ${format(end, 'MMM d')}`;
}

/** Evenly sample up to `limit` items, keeping chronological order. */
function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const picked: T[] = [];
  for (let i = 0; i < limit; i++) {
    picked.push(items[Math.round((i * (items.length - 1)) / (limit - 1))]);
  }
  return picked;
}

export function computeYearlyStats(inputs: ReviewInputs): YearlyStats {
  const base = computeReviewStats(inputs);
  const { period } = inputs;
  const isoYear = period.isoYear;

  const completions = inputs.completions.filter(c => c.is_completed && inPeriod(c.event_date, period));
  const sessions = inputs.sessions.filter(s => inPeriod(s.event_date, period));
  const seconds = sessionSecondsMap(sessions);

  const months: MonthLite[] = [];
  for (let m = 1; m <= 13; m++) {
    const monthPeriod = buildReviewPeriod('month', isoYear, m);
    const inMonth = (date: string) => date >= monthPeriod.startDate && date < monthPeriod.endDateExclusive;
    const monthCompletions = completions.filter(c => inMonth(c.event_date));
    const strength = computeStrengthStats(inputs.setLogs, monthPeriod);
    const cardio = computeCardioStats(inputs.cardioLogs, monthPeriod);
    months.push({
      monthIndex: m,
      label: monthRangeLabel(isoYear, m),
      sessions: monthCompletions.length,
      durationMinutes: Math.round(
        monthCompletions.reduce((sum, c) => sum + durationMinutesFor(c, seconds), 0),
      ),
      tonnage: strength.tonnage,
      distanceByUnit: cardio.distanceByUnit,
      prCount: base.prs.filter(pr => inMonth(pr.date)).length,
    });
  }

  const bestMonth =
    months
      .filter(m => m.sessions > 0)
      .sort((a, b) => b.sessions - a.sessions || b.durationMinutes - a.durationMinutes || a.monthIndex - b.monthIndex)[0] ??
    null;

  const bestCategory =
    Object.entries(base.totals.sessionsByType)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => ({ type, sessions: count }))[0] ?? null;

  // Halves: months 1–7 vs 8–13 (13 months split unevenly; month 7 → H1).
  const halves = new Map<string, { firstHalf: number; secondHalf: number }>();
  for (const completion of completions) {
    const month = getIsoMonth(parseISO(completion.event_date)).month;
    const entry = halves.get(completion.event_type) ?? { firstHalf: 0, secondHalf: 0 };
    if (month <= 7) entry.firstHalf += 1;
    else entry.secondHalf += 1;
    halves.set(completion.event_type, entry);
  }
  const mostImprovedCategory =
    [...halves.entries()]
      .map(([type, h]) => ({ type, ...h, delta: h.secondHalf - h.firstHalf }))
      .filter(c => c.delta > 0)
      .sort((a, b) => b.delta - a.delta || a.type.localeCompare(b.type))
      .map(({ type, firstHalf, secondHalf }) => ({ type, firstHalf, secondHalf }))[0] ?? null;

  const biggestPRs = [...base.prs]
    .sort((a, b) => relativeImprovement(b) - relativeImprovement(a) || (a.date < b.date ? -1 : 1))
    .slice(0, 5);

  // Deterministic highlight shortlist for the AI to riff on — never a source
  // of new numbers, only pointers at ones computed above.
  const memorable: string[] = [];
  const prsByDate = new Map<string, DatedPersonalRecord[]>();
  for (const pr of base.prs) {
    const group = prsByDate.get(pr.date);
    if (group) group.push(pr);
    else prsByDate.set(pr.date, [pr]);
  }
  const multiPRDays = [...prsByDate.entries()]
    .filter(([, group]) => group.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8);
  for (const [date, group] of multiPRDays) {
    const names = [...new Set(group.map(pr => pr.exerciseName))].join(', ');
    memorable.push(`${format(parseISO(date), 'MMM d')} — ${group.length} PRs in one day: ${names}`);
  }
  if (base.cardio.longestDistance) {
    const d = base.cardio.longestDistance;
    memorable.push(
      `Longest distance: ${d.value}${d.unit ? ` ${d.unit}` : ''} (${d.exerciseName}) on ${format(parseISO(d.date), 'MMM d')}`,
    );
  }
  if (base.cardio.biggestClimb) {
    const c = base.cardio.biggestClimb;
    memorable.push(
      `Biggest climb: ${c.value}${c.unit ? ` ${c.unit}` : ''} elevation (${c.exerciseName}) on ${format(parseISO(c.date), 'MMM d')}`,
    );
  }
  if (base.notable.longestSession) {
    const s = base.notable.longestSession;
    memorable.push(`Longest session: ${s.minutes} min — ${s.title} on ${format(parseISO(s.date), 'MMM d')}`);
  }
  const summaries = sessions
    .filter(s => s.coach_summary?.trim())
    .sort((a, b) => (a.event_date < b.event_date ? -1 : 1));
  for (const s of sampleEvenly(summaries, 10)) {
    const text = s.coach_summary!.trim();
    const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    memorable.push(`Coach note, ${format(parseISO(s.event_date), 'MMM d')}: “${excerpt}”`);
  }

  return {
    ...base,
    months,
    bestMonth,
    bestCategory,
    mostImprovedCategory,
    biggestPRs,
    memorableCandidates: memorable,
  };
}
