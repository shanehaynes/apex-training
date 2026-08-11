import type { McpToolDef } from '../protocol.js';
import { ToolInputError } from '../protocol.js';
import { optionalEnum, optionalInt, requireDateRange, requireString } from '../args.js';
import { fetchCanonicalHistory } from '../data.js';
import { fetchPeriodInputs } from '../../reviewData.js';
import type { CardioLogRow, SetLogRow } from '../../../../src/lib/db/types.js';
import type { StatsPeriod } from '../../../../src/lib/review/types.js';
import {
  bestHistoricalCardio,
  bestHistoricalDuration,
  bestHistoricalOneRM,
  bestHistoricalReps,
  classifySet,
  describeRecord,
} from '../../../../src/lib/tracking/records.js';
import { buildExerciseStats } from '../../../../src/lib/library/stats.js';
import { buildReviewPeriod, computePeriodPRs, computeReviewStats } from '../../../../src/lib/review/stats.js';
import { canonicalNameOf } from '../../../../src/lib/schedule/definitions.js';
import { formatSeconds } from '../../../../src/lib/time.js';

// History / PR / aggregate tools. All numbers come from the same pure
// functions the app's tracker, library, and review email use — the model
// cites them, it never derives.

const DAY_MS = 86_400_000;
const MAX_PR_PERIOD_DAYS = 366;
const MAX_TREND_POINTS = 100;

/** Keep first/last, evenly thin the middle. */
function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function describeLoggedSet(row: SetLogRow): string | null {
  const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration);
  if (!set) return null;
  switch (set.kind) {
    case 'oneRM': return `${set.weight} × ${set.reps}`;
    case 'duration': return formatSeconds(set.seconds);
    case 'reps': return `${set.reps} reps`;
  }
}

function describeLoggedCardio(row: CardioLogRow): string | null {
  const parts: string[] = [];
  if (row.duration_minutes != null) parts.push(`${row.duration_minutes} min`);
  if (row.distance) parts.push(row.distance);
  if (row.elevation_gain) parts.push(`↑ ${row.elevation_gain}`);
  return parts.length ? parts.join(' · ') : null;
}

export const getExerciseHistoryTool: McpToolDef = {
  name: 'get_exercise_history',
  description:
    'Progression history for one exercise: all-time best, per-session trend, and recent logged sessions. ' +
    'Name matching is alias-aware (former names resolve to the current one). ' +
    'Use search_exercises first if unsure of the name.',
  inputSchema: {
    type: 'object',
    properties: {
      exercise_name: { type: 'string', description: 'Exercise name or any known alias.' },
      limit: { type: 'integer', description: 'Recent sessions to include (default 10, max 50).' },
    },
    required: ['exercise_name'],
  },
  async run(supabase, userId, args) {
    const rawName = requireString(args, 'exercise_name');
    const limit = optionalInt(args, 'limit', 10, 1, 50);

    const { setLogs, cardioLogs, aliasIndex } = await fetchCanonicalHistory(supabase, userId);
    const canonical = canonicalNameOf(rawName, aliasIndex);
    const setRows = setLogs.filter(r => r.exercise_name === canonical);
    const cardioRows = cardioLogs.filter(r => r.exercise_name === canonical);
    if (setRows.length === 0 && cardioRows.length === 0) {
      throw new ToolInputError(
        `No logged history for "${rawName}"${canonical !== rawName ? ` (resolved to "${canonical}")` : ''}. ` +
        'Use search_exercises to find the right name.',
      );
    }

    const stats = buildExerciseStats(setRows, cardioRows);

    // Recent sessions, newest first, with the sets actually logged. (The
    // library page caps at 6; the tool honors the caller's limit instead.)
    const byDate = new Map<string, string[]>();
    const describe = setRows.length
      ? setRows.map(r => ({ date: r.event_date, label: describeLoggedSet(r) }))
      : cardioRows.map(r => ({ date: r.event_date, label: describeLoggedCardio(r) }));
    for (const { date, label } of describe) {
      if (!label) continue;
      byDate.set(date, [...(byDate.get(date) ?? []), label]);
    }
    const recentSessions = [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, limit)
      .map(([date, sets]) => ({ date, sets }));

    return {
      canonical_name: canonical,
      resolved_from: canonical !== rawName ? rawName : undefined,
      stat_kind: stats.kind,
      stat_unit: stats.kindLabel,
      all_time_best: stats.pr,
      total_sessions: stats.totalSessions,
      trend: downsample(stats.trend, MAX_TREND_POINTS),
      recent_sessions: recentSessions,
    };
  },
};

export const getPrsTool: McpToolDef = {
  name: 'get_prs',
  description:
    'Personal records. scope "all_time" lists the best-ever lift (estimated 1RM via Epley), hold, rep count, ' +
    'and cardio distance/elevation per exercise; scope "period" lists records SET within a date range, ' +
    'each compared to what it beat.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['all_time', 'period'], description: 'Default all_time.' },
      start_date: { type: 'string', description: 'Required for scope "period". YYYY-MM-DD.' },
      end_date: { type: 'string', description: 'Required for scope "period". YYYY-MM-DD (inclusive, max 366 days).' },
    },
  },
  async run(supabase, userId, args) {
    const scope = optionalEnum(args, 'scope', ['all_time', 'period'] as const, 'all_time');
    const { setLogs, cardioLogs } = await fetchCanonicalHistory(supabase, userId);

    if (scope === 'period') {
      const { startDate, endDate } = requireDateRange(args, MAX_PR_PERIOD_DAYS);
      const endExclusive = new Date(Date.parse(endDate) + DAY_MS).toISOString().slice(0, 10);
      const days = (Date.parse(endExclusive) - Date.parse(startDate)) / DAY_MS;
      const period: StatsPeriod = {
        startDate,
        endDateExclusive: endExclusive,
        periodType: 'block',
        label: `${startDate} – ${endDate}`,
        weeksInPeriod: Math.max(1, Math.round(days / 7)),
      };
      const prs = computePeriodPRs(
        setLogs.filter(r => r.event_date < endExclusive),
        cardioLogs.filter(r => r.event_date < endExclusive),
        period,
      );
      return {
        scope,
        start_date: startDate,
        end_date: endDate,
        records: prs.map(pr => ({ ...pr, description: describeRecord(pr) })),
      };
    }

    const oneRM = bestHistoricalOneRM(setLogs);
    const duration = bestHistoricalDuration(setLogs);
    const reps = bestHistoricalReps(setLogs);
    const cardio = bestHistoricalCardio(cardioLogs);

    const splitKey = (key: string) => {
      const idx = key.lastIndexOf('|');
      return { exercise: key.slice(0, idx), unit: key.slice(idx + 1) };
    };

    return {
      scope,
      lifts: [...oneRM.entries()].map(([exercise, best]) => ({
        exercise,
        estimated_1rm: Math.round(best.oneRM),
        weight: best.weight,
        reps: best.reps,
        date: best.date,
      })),
      holds: [...duration.entries()].map(([exercise, best]) => ({
        exercise,
        seconds: best.value,
        display: formatSeconds(best.value),
        date: best.date,
      })),
      reps: [...reps.entries()].map(([exercise, best]) => ({ exercise, reps: best.value, date: best.date })),
      cardio_distance: [...cardio.distance.entries()].map(([key, best]) => ({
        ...splitKey(key),
        value: best.value,
        date: best.date,
      })),
      cardio_elevation: [...cardio.elevation.entries()].map(([key, best]) => ({
        ...splitKey(key),
        value: best.value,
        date: best.date,
      })),
    };
  },
};

export const getPeriodStatsTool: McpToolDef = {
  name: 'get_period_stats',
  description:
    'Aggregated training stats for one month or year of the 13-month ISO training calendar: session totals ' +
    'by type, active days/weeks, cardio distance/elevation by unit, strength tonnage, streaks, and PRs set ' +
    'in the period. Months are 1–13 (each 4 ISO weeks; month 13 may have 5).',
  inputSchema: {
    type: 'object',
    properties: {
      period_type: { type: 'string', enum: ['month', 'year'] },
      year: { type: 'integer', description: 'ISO year, e.g. 2026.' },
      month: { type: 'integer', description: '1–13 (ISO training month). Required when period_type is "month".' },
    },
    required: ['period_type', 'year'],
  },
  async run(supabase, userId, args) {
    const periodType = optionalEnum(args, 'period_type', ['month', 'year'] as const, 'month');
    const year = optionalInt(args, 'year', 0, 2000, 2100);
    if (year === 0) throw new ToolInputError('year is required.');
    let month: number | undefined;
    if (periodType === 'month') {
      month = optionalInt(args, 'month', 0, 1, 13);
      if (month === 0) throw new ToolInputError('month (1–13) is required when period_type is "month".');
    }

    const period = buildReviewPeriod(periodType, year, month);
    const inputs = await fetchPeriodInputs(supabase, userId, period);
    const stats = computeReviewStats(inputs);

    return {
      ...stats,
      prs: stats.prs.map(pr => ({ ...pr, description: describeRecord(pr) })),
    };
  },
};
