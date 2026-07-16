import { describeDatedRecord, formatMinutes, formatNumber, formatUnitMap, shortDate } from './formats';
import type { ReviewStats, YearlyStats } from './types';

// ─── AI recap: the model's entire view of the period ─────────────────────────
// Follows the buildSessionRecap pattern (src/lib/coach/summary.ts): every
// figure is pre-computed by stats.ts and rendered here as plain text; the
// model narrates it and is explicitly forbidden from inventing numbers.

export const REVIEW_MODEL = 'claude-opus-4-8';
export const MONTHLY_MAX_TOKENS = 400;
export const YEARLY_MAX_TOKENS = 800;

export const MONTHLY_REVIEW_SYSTEM_PROMPT =
  "You are the user's personal training coach writing the closing note for their 4-week " +
  'training month. You will receive a pre-computed stats recap. Write 4-6 sentences: ' +
  'acknowledge the volume of work, call out the personal records listed in the recap ' +
  '(they are pre-computed and verified — never invent records or numbers that are not ' +
  'listed), and make one pointed observation, e.g. a standout week, a neglected category, ' +
  'or a consistency streak. Speak directly to the user in second person. Plain prose ' +
  'only: no greeting, no sign-off, no markdown, no bullet points.';

export const YEARLY_REVIEW_SYSTEM_PROMPT =
  "You are the user's personal training coach writing their year-in-review — think " +
  "Strava's yearly recap, but covering everything they log: weights, climbing, cardio, " +
  'yoga, stretching, morning routines. You will receive a pre-computed stats recap. ' +
  'Write 2-3 short paragraphs: open with the shape of the year (volume, breadth, ' +
  'consistency), celebrate the best month and the biggest personal records, and weave in ' +
  'one or two of the memorable moments listed in the recap — you may quote the coach ' +
  'notes. Every number and event must come from the recap; never invent any. Close with ' +
  'one sentence looking to the year ahead. Speak directly to the user in second person. ' +
  'Plain prose paragraphs separated by blank lines: no greeting, no sign-off, no ' +
  'markdown, no bullet points.';

function statsBody(stats: ReviewStats): string[] {
  const lines: string[] = [];
  const t = stats.totals;

  lines.push(
    `Sessions completed: ${t.sessionsCompleted} across ${t.activeDays} active day${t.activeDays === 1 ? '' : 's'} ` +
      `(${t.weeksActive} of ${stats.period.weeksInPeriod} weeks active)`,
  );
  const byType = Object.entries(t.sessionsByType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
  if (byType) lines.push(`By type: ${byType}`);
  if (t.totalDurationMinutes > 0) lines.push(`Total training time: ${formatMinutes(t.totalDurationMinutes)}`);
  if (stats.streaks.longestActiveDayStreak > 1) {
    lines.push(`Longest daily streak: ${stats.streaks.longestActiveDayStreak} days`);
  }
  if (stats.streaks.mostActiveWeek) {
    const w = stats.streaks.mostActiveWeek;
    lines.push(`Most active week: week of ${shortDate(w.weekStart)} (${w.sessions} sessions)`);
  }
  if (stats.notable.longestSession) {
    const s = stats.notable.longestSession;
    lines.push(`Longest session: ${s.minutes} min — ${s.title} (${shortDate(s.date)})`);
  }

  const st = stats.strength;
  if (st.totalSets > 0) {
    lines.push('');
    lines.push('Strength:');
    if (st.tonnage > 0) {
      lines.push(`Total weight moved: ${formatNumber(st.tonnage)} (sum of weight × reps, in units as logged)`);
    }
    lines.push(`Sets: ${st.totalSets}, reps: ${formatNumber(st.totalReps)}`);
    if (st.heaviestSet) {
      const h = st.heaviestSet;
      lines.push(`Heaviest set: ${formatNumber(h.weight)} × ${h.reps} — ${h.exerciseName} (${shortDate(h.date)})`);
    }
    if (st.topExercises.length > 0) {
      lines.push(`Most-trained: ${st.topExercises.map(e => `${e.exerciseName} (${e.sets} sets)`).join(', ')}`);
    }
  }

  const c = stats.cardio;
  const hasCardio = Object.keys(c.distanceByUnit).length > 0 || Object.keys(c.elevationByUnit).length > 0;
  if (hasCardio) {
    lines.push('');
    lines.push('Cardio:');
    if (Object.keys(c.distanceByUnit).length > 0) lines.push(`Distance: ${formatUnitMap(c.distanceByUnit)}`);
    if (Object.keys(c.elevationByUnit).length > 0) lines.push(`Elevation gain: ${formatUnitMap(c.elevationByUnit)}`);
    if (c.longestDistance) {
      const d = c.longestDistance;
      lines.push(
        `Longest distance: ${formatNumber(d.value)}${d.unit ? ` ${d.unit}` : ''} — ${d.exerciseName} (${shortDate(d.date)})`,
      );
    }
    if (c.biggestClimb) {
      const b = c.biggestClimb;
      lines.push(
        `Biggest climb: ${formatNumber(b.value)}${b.unit ? ` ${b.unit}` : ''} elevation — ${b.exerciseName} (${shortDate(b.date)})`,
      );
    }
  }

  lines.push('');
  if (stats.prs.length > 0) {
    lines.push(`PERSONAL RECORDS (${stats.prs.length} — pre-computed and verified; never invent records not listed):`);
    for (const pr of stats.prs) lines.push(`- ${describeDatedRecord(pr)}`);
  } else {
    lines.push('No personal records this period.');
  }

  return lines;
}

export function buildMonthlyRecap(stats: ReviewStats, displayName: string): string {
  const lines: string[] = [
    `Training month in review for ${displayName}: ${stats.period.label} ` +
      `(training month ${stats.period.monthIndex} of 13, ${stats.period.isoYear})`,
    '',
    ...statsBody(stats),
  ];
  return lines.join('\n');
}

export function buildYearlyRecap(stats: YearlyStats, displayName: string): string {
  const lines: string[] = [
    `Year in training for ${displayName}: ${stats.period.isoYear} (13 four-week training months, ` +
      `${stats.period.weeksInPeriod} weeks)`,
    '',
    ...statsBody(stats),
    '',
    'Month by month (sessions / time / PRs):',
  ];
  for (const m of stats.months) {
    lines.push(
      `- Month ${m.monthIndex} (${m.label}): ${m.sessions} sessions, ${formatMinutes(m.durationMinutes)}` +
        `${m.prCount > 0 ? `, ${m.prCount} PR${m.prCount === 1 ? '' : 's'}` : ''}`,
    );
  }
  if (stats.bestMonth) {
    const b = stats.bestMonth;
    lines.push(
      `Best month: month ${b.monthIndex} (${b.label}) — ${b.sessions} sessions, ${formatMinutes(b.durationMinutes)}`,
    );
  }
  if (stats.bestCategory) {
    lines.push(`Top category: ${stats.bestCategory.type} (${stats.bestCategory.sessions} sessions)`);
  }
  if (stats.mostImprovedCategory) {
    const i = stats.mostImprovedCategory;
    lines.push(`Most improved: ${i.type} (${i.firstHalf} sessions in the first half → ${i.secondHalf} in the second)`);
  }
  if (stats.biggestPRs.length > 0) {
    lines.push('');
    lines.push('Biggest PRs of the year:');
    for (const pr of stats.biggestPRs) lines.push(`- ${describeDatedRecord(pr)}`);
  }
  if (stats.memorableCandidates.length > 0) {
    lines.push('');
    lines.push('Memorable moments (pre-computed shortlist — you may reference or quote these):');
    for (const line of stats.memorableCandidates) lines.push(`- ${line}`);
  }
  return lines.join('\n');
}
