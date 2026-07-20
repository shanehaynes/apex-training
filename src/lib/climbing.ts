import type { AscentStyle, ClimbStyle, ClimbingTargets, Exercise, WorkoutEvent, WorkoutType } from '../types/workout';

// ─── Climbing domain logic ────────────────────────────────────────────────────
// Pure helpers for the outdoor-climbing event type: each exercise entry with
// category 'climbing' is one pitch (style + grade). Event-level max grade and
// total pitches are derived from the pitch list unless explicitly set.

export const CLIMB_STYLES: { value: ClimbStyle; label: string }[] = [
  { value: 'sport',     label: 'Sport' },
  { value: 'trad',      label: 'Trad' },
  { value: 'boulder',   label: 'Boulder' },
  { value: 'ice-mixed', label: 'Ice/Mixed' },
];

export function climbStyleLabel(style: ClimbStyle | undefined): string {
  return CLIMB_STYLES.find(s => s.value === style)?.label ?? 'Climb';
}

export const ASCENT_STYLES: { value: AscentStyle; label: string }[] = [
  { value: 'flash',    label: 'Flashed' },
  { value: 'redpoint', label: 'Redpointed' },
  { value: 'follow',   label: 'Followed' },
  { value: 'attempt',  label: 'Attempted' },
];

export function ascentStyleLabel(style: AscentStyle | undefined): string | undefined {
  return ASCENT_STYLES.find(s => s.value === style)?.label;
}

/** Ascent options for a discipline: following needs a rope, so boulders drop it. */
export function ascentStylesFor(style: ClimbStyle | undefined): { value: AscentStyle; label: string }[] {
  return style === 'boulder' ? ASCENT_STYLES.filter(s => s.value !== 'follow') : ASCENT_STYLES;
}

// ─── Grade parsing ────────────────────────────────────────────────────────────
// Grades only order within their own scale — a V5 never races a 5.11a. The
// scales recognized: YDS routes (5.x with optional letter or +/−), V-grades
// (boulder, VB below V0), WI/AI (ice), M (mixed).

type GradeScale = 'yds' | 'boulder' | 'ice' | 'mixed';

/** Scale + rank for ordering, or null when the text is no recognizable grade. */
export function parseGrade(raw: string | undefined): { scale: GradeScale; rank: number } | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();

  // YDS: 5.9, 5.9+, 5.11a, 5.12d. A bare number sits mid-letter-range so
  // 5.10 lands between 5.10a and 5.10d; +/− nudge by half a letter step.
  const yds = v.match(/^5\.(\d{1,2})\s*([A-D])?\s*([+-])?$/);
  if (yds) {
    const minor = Number(yds[1]);
    const letter = yds[2] ? (yds[2].charCodeAt(0) - 64) * 20 : 50; // a=20 … d=80, none=50
    const mod = yds[3] === '+' ? 10 : yds[3] === '-' ? -10 : 0;
    return { scale: 'yds', rank: minor * 100 + letter + mod };
  }

  const boulder = v.match(/^V(B|\d{1,2})\s*([+-])?$/);
  if (boulder) {
    const n = boulder[1] === 'B' ? -1 : Number(boulder[1]);
    return { scale: 'boulder', rank: n * 10 + (boulder[2] === '+' ? 5 : boulder[2] === '-' ? -5 : 0) };
  }

  const ice = v.match(/^[WA]I\s*(\d{1,2})\s*([+-])?$/);
  if (ice) return { scale: 'ice', rank: Number(ice[1]) * 10 + (ice[2] === '+' ? 5 : ice[2] === '-' ? -5 : 0) };

  const mixed = v.match(/^M(\d{1,2})\s*([+-])?$/);
  if (mixed) return { scale: 'mixed', rank: Number(mixed[1]) * 10 + (mixed[2] === '+' ? 5 : mixed[2] === '-' ? -5 : 0) };

  return null;
}

const SCALE_ORDER: GradeScale[] = ['yds', 'boulder', 'ice', 'mixed'];

/**
 * Hardest grade in the list, compared within each scale; a day that mixes
 * scales reports the max of each ("5.11a · V5"). Unparseable text is skipped.
 */
export function maxGradeOf(grades: (string | undefined)[]): string | undefined {
  const bestByScale = new Map<GradeScale, { rank: number; text: string }>();
  for (const grade of grades) {
    const parsed = parseGrade(grade);
    if (!parsed) continue;
    const best = bestByScale.get(parsed.scale);
    if (!best || parsed.rank > best.rank) bestByScale.set(parsed.scale, { rank: parsed.rank, text: grade!.trim() });
  }
  const parts = SCALE_ORDER.filter(s => bestByScale.has(s)).map(s => bestByScale.get(s)!.text);
  return parts.length ? parts.join(' · ') : undefined;
}

// ─── Event-level resolution ───────────────────────────────────────────────────

export function isOutdoorClimbing(type: WorkoutType): boolean {
  return type === 'outdoor-climbing';
}

/** The event's pitches: main-work entries with category 'climbing'. */
export function eventPitches(exercises: Exercise[] | undefined): Exercise[] {
  return (exercises ?? []).filter(e => e.category === 'climbing');
}

/**
 * Effective session targets: explicitly set fields win; the rest derive from
 * the pitch list (count, and max grade across pitch grades).
 */
export function resolveClimbingTargets(
  event: Pick<WorkoutEvent, 'exercises' | 'climbingTargets'>,
): Required<Pick<ClimbingTargets, 'totalPitches'>> & Pick<ClimbingTargets, 'maxGrade'> {
  const pitches = eventPitches(event.exercises);
  return {
    maxGrade: event.climbingTargets?.maxGrade || maxGradeOf(pitches.map(p => p.grade)),
    totalPitches: event.climbingTargets?.totalPitches ?? pitches.length,
  };
}

// ─── Section labels ───────────────────────────────────────────────────────────
// Outdoor climbing renames the sections: the warm-up is the approach hike and
// the cool-down is the descent (both cardio); main work is the pitch list.

export interface SectionLabels {
  warmup: string;
  exercises: string;
  cooldown: string;
}

const DEFAULT_LABELS: SectionLabels = { warmup: 'Warm-Up', exercises: 'Main Work', cooldown: 'Cool-Down' };
const OUTDOOR_LABELS: SectionLabels = { warmup: 'Approach', exercises: 'Pitches', cooldown: 'Descent' };

export function sectionLabels(type: WorkoutType | undefined): SectionLabels {
  return type === 'outdoor-climbing' ? OUTDOOR_LABELS : DEFAULT_LABELS;
}
