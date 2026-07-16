import { addDays, format, parseISO } from 'date-fns';
import { describeDatedRecord, formatMinutes, formatNumber, formatUnitMap, shortDate } from './formats.js';
import type { ReviewStats, YearlyStats } from './types.js';

// ─── Review email rendering ───────────────────────────────────────────────────
// Pure string builders: a simple single-column HTML layout (inline styles
// only — email clients strip everything else) plus a plain-text alternative.
// Every figure comes from the pre-computed stats object.

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const isYearly = (stats: ReviewStats): stats is YearlyStats => stats.period.periodType === 'year';

/** "Jun 15 – Jul 12" — the period range without years, for the subject. */
function shortRange(stats: ReviewStats): string {
  const start = parseISO(stats.period.startDate);
  const end = addDays(parseISO(stats.period.endDateExclusive), -1);
  return `${format(start, 'MMM d')} – ${format(end, 'MMM d')}`;
}

// ─── HTML building blocks ─────────────────────────────────────────────────────

const COLORS = {
  text: '#1f2328',
  muted: '#6a737d',
  border: '#e4e7eb',
  accent: '#2f6f4f',
  tileBg: '#f6f8f7',
};

function statTile(value: string, label: string): string {
  return (
    `<td width="50%" style="padding:6px;">` +
    `<div style="background:${COLORS.tileBg};border-radius:8px;padding:14px 16px;">` +
    `<div style="font-size:22px;font-weight:700;color:${COLORS.text};">${escapeHtml(value)}</div>` +
    `<div style="font-size:12px;color:${COLORS.muted};text-transform:uppercase;letter-spacing:0.04em;margin-top:2px;">${escapeHtml(label)}</div>` +
    `</div></td>`
  );
}

function statGrid(tiles: Array<[string, string]>): string {
  if (tiles.length === 0) return '';
  const rows: string[] = [];
  for (let i = 0; i < tiles.length; i += 2) {
    const cells = tiles
      .slice(i, i + 2)
      .map(([value, label]) => statTile(value, label))
      .join('');
    rows.push(`<tr>${cells}${tiles.length - i === 1 ? '<td width="50%"></td>' : ''}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;">${rows.join('')}</table>`;
}

function sectionTitle(title: string): string {
  return (
    `<h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.06em;color:${COLORS.muted};` +
    `margin:28px 0 8px;border-bottom:1px solid ${COLORS.border};padding-bottom:6px;">${escapeHtml(title)}</h2>`
  );
}

function detailLine(label: string, value: string): string {
  return (
    `<p style="margin:4px 0;font-size:14px;color:${COLORS.text};">` +
    `<span style="color:${COLORS.muted};">${escapeHtml(label)}:</span> ${escapeHtml(value)}</p>`
  );
}

function listItems(items: string[]): string {
  return items
    .map(item => `<li style="margin:4px 0;font-size:14px;color:${COLORS.text};">${escapeHtml(item)}</li>`)
    .join('');
}

// ─── Shared content assembly ──────────────────────────────────────────────────
// Each content line is rendered once here and consumed by both the HTML and
// plain-text bodies, so the two never drift.

interface Section {
  title: string;
  details: Array<[string, string]>;
  list?: string[];
}

function buildSections(stats: ReviewStats): Section[] {
  const sections: Section[] = [];
  const t = stats.totals;

  const activity: Section = { title: 'Activity', details: [] };
  const byType = Object.entries(t.sessionsByType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
  if (byType) activity.details.push(['By type', byType]);
  activity.details.push(['Active days', `${t.activeDays} (${t.weeksActive} of ${stats.period.weeksInPeriod} weeks)`]);
  if (stats.streaks.longestActiveDayStreak > 1) {
    activity.details.push(['Longest streak', `${stats.streaks.longestActiveDayStreak} days`]);
  }
  if (stats.streaks.mostActiveWeek) {
    const w = stats.streaks.mostActiveWeek;
    activity.details.push(['Most active week', `week of ${shortDate(w.weekStart)} (${w.sessions} sessions)`]);
  }
  if (stats.notable.longestSession) {
    const s = stats.notable.longestSession;
    activity.details.push(['Longest session', `${s.minutes} min — ${s.title} (${shortDate(s.date)})`]);
  }
  sections.push(activity);

  const st = stats.strength;
  if (st.totalSets > 0) {
    const strength: Section = { title: 'Strength', details: [] };
    if (st.tonnage > 0) strength.details.push(['Total weight moved', `${formatNumber(st.tonnage)} (weight × reps, as logged)`]);
    strength.details.push(['Sets · reps', `${st.totalSets} · ${formatNumber(st.totalReps)}`]);
    if (st.heaviestSet) {
      const h = st.heaviestSet;
      strength.details.push(['Heaviest set', `${formatNumber(h.weight)} × ${h.reps} — ${h.exerciseName} (${shortDate(h.date)})`]);
    }
    if (st.topExercises.length > 0) {
      strength.details.push(['Most-trained', st.topExercises.map(e => `${e.exerciseName} (${e.sets})`).join(', ')]);
    }
    sections.push(strength);
  }

  const c = stats.cardio;
  if (Object.keys(c.distanceByUnit).length > 0 || Object.keys(c.elevationByUnit).length > 0) {
    const cardio: Section = { title: 'Cardio', details: [] };
    if (Object.keys(c.distanceByUnit).length > 0) cardio.details.push(['Distance', formatUnitMap(c.distanceByUnit)]);
    if (Object.keys(c.elevationByUnit).length > 0) cardio.details.push(['Elevation gain', formatUnitMap(c.elevationByUnit)]);
    if (c.longestDistance) {
      const d = c.longestDistance;
      cardio.details.push(['Longest distance', `${formatNumber(d.value)}${d.unit ? ` ${d.unit}` : ''} — ${d.exerciseName} (${shortDate(d.date)})`]);
    }
    if (c.biggestClimb) {
      const b = c.biggestClimb;
      cardio.details.push(['Biggest climb', `${formatNumber(b.value)}${b.unit ? ` ${b.unit}` : ''} — ${b.exerciseName} (${shortDate(b.date)})`]);
    }
    sections.push(cardio);
  }

  sections.push({
    title: `Personal records (${stats.prs.length})`,
    details: [],
    list: stats.prs.length > 0 ? stats.prs.map(describeDatedRecord) : ['No personal records this period.'],
  });

  if (isYearly(stats)) {
    const retro: Section = { title: 'The year, month by month', details: [] };
    retro.list = stats.months.map(
      m =>
        `Month ${m.monthIndex} (${m.label}): ${m.sessions} sessions, ${formatMinutes(m.durationMinutes)}` +
        `${m.prCount > 0 ? `, ${m.prCount} PR${m.prCount === 1 ? '' : 's'}` : ''}`,
    );
    sections.push(retro);

    const highlights: Section = { title: 'Retrospective', details: [] };
    if (stats.bestMonth) {
      const b = stats.bestMonth;
      highlights.details.push(['Best month', `month ${b.monthIndex} (${b.label}) — ${b.sessions} sessions, ${formatMinutes(b.durationMinutes)}`]);
    }
    if (stats.bestCategory) {
      highlights.details.push(['Top category', `${stats.bestCategory.type} (${stats.bestCategory.sessions} sessions)`]);
    }
    if (stats.mostImprovedCategory) {
      const i = stats.mostImprovedCategory;
      highlights.details.push(['Most improved', `${i.type} (${i.firstHalf} → ${i.secondHalf} sessions, first vs second half)`]);
    }
    if (stats.biggestPRs.length > 0) {
      highlights.list = stats.biggestPRs.map(pr => `Biggest PR: ${describeDatedRecord(pr)}`);
    }
    if (highlights.details.length > 0 || highlights.list) sections.push(highlights);

    if (stats.memorableCandidates.length > 0) {
      sections.push({ title: 'Memorable moments', details: [], list: stats.memorableCandidates });
    }
  }

  return sections;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export function renderReviewEmail(
  stats: ReviewStats | YearlyStats,
  aiCommentary: string | null,
  displayName: string,
): RenderedEmail {
  const yearly = isYearly(stats);
  const subject = yearly
    ? `Your ${stats.period.isoYear} year in training`
    : `Your training month in review: ${shortRange(stats)}`;
  const heading = yearly ? `${stats.period.isoYear} — Year in training` : 'Training month in review';
  const subheading = yearly
    ? `${stats.period.weeksInPeriod} weeks · 13 training months`
    : `${stats.period.label} · month ${stats.period.monthIndex} of 13`;

  const t = stats.totals;
  const tiles: Array<[string, string]> = [[String(t.sessionsCompleted), 'Sessions']];
  if (t.totalDurationMinutes > 0) tiles.push([formatMinutes(t.totalDurationMinutes), 'Training time']);
  if (stats.strength.tonnage > 0) tiles.push([formatNumber(stats.strength.tonnage), 'Weight moved']);
  if (Object.keys(stats.cardio.distanceByUnit).length > 0) tiles.push([formatUnitMap(stats.cardio.distanceByUnit), 'Distance']);
  if (Object.keys(stats.cardio.elevationByUnit).length > 0) tiles.push([formatUnitMap(stats.cardio.elevationByUnit), 'Elevation gain']);
  tiles.push([String(stats.prs.length), 'Personal records']);

  const sections = buildSections(stats);

  const commentary = aiCommentary?.trim() || null;
  const commentaryHtml = commentary
    ? `<div style="border-left:3px solid ${COLORS.accent};padding:2px 0 2px 14px;margin:20px 0;">` +
      commentary
        .split(/\n{2,}/)
        .map(p => `<p style="margin:8px 0;font-size:15px;line-height:1.55;color:${COLORS.text};">${escapeHtml(p.trim())}</p>`)
        .join('') +
      `<p style="margin:8px 0 0;font-size:12px;color:${COLORS.muted};">— your coach</p></div>`
    : '';

  const sectionsHtml = sections
    .map(
      s =>
        sectionTitle(s.title) +
        s.details.map(([label, value]) => detailLine(label, value)).join('') +
        (s.list ? `<ul style="margin:6px 0;padding-left:20px;">${listItems(s.list)}</ul>` : ''),
    )
    .join('');

  // Explicit white background: without it, dark-mode email clients paint the
  // near-black text on their own dark canvas.
  const html =
    `<div style="background:#ffffff;margin:0 auto;max-width:560px;padding:24px 16px;` +
    `font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${COLORS.text};">` +
    `<p style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.accent};margin:0 0 4px;">Apex Training</p>` +
    `<h1 style="font-size:24px;margin:0;color:${COLORS.text};">${escapeHtml(heading)}</h1>` +
    `<p style="font-size:14px;color:${COLORS.muted};margin:4px 0 0;">${escapeHtml(subheading)} · ${escapeHtml(displayName)}</p>` +
    commentaryHtml +
    statGrid(tiles) +
    sectionsHtml +
    `<p style="font-size:12px;color:${COLORS.muted};margin:32px 0 0;border-top:1px solid ${COLORS.border};padding-top:12px;">` +
    `Numbers are computed from your logged workouts; weights and distances are summed in the units you logged them.</p>` +
    `</div>`;

  const textLines: string[] = [`APEX TRAINING — ${heading}`, `${subheading} · ${displayName}`, ''];
  if (commentary) textLines.push(commentary, '');
  for (const [value, label] of tiles) textLines.push(`${label}: ${value}`);
  for (const s of sections) {
    textLines.push('', s.title.toUpperCase());
    for (const [label, value] of s.details) textLines.push(`${label}: ${value}`);
    if (s.list) for (const item of s.list) textLines.push(`- ${item}`);
  }
  return { subject, html, text: textLines.join('\n') };
}
