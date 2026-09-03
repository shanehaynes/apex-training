import { format, parseISO } from 'date-fns';
import { mealCalories, sumDayMacros } from '../nutrition/mapping.js';
import type { Meal } from '../../types/nutrition';
import type { WorkoutEvent } from '../../types/workout';
import type { TrackedSectionGroup } from '../tracking/plan';
import { describeRecord } from '../tracking/records.js';
import type { PersonalRecord } from '../tracking/records';

// ─── Post-workout coach recap ─────────────────────────────────────────────────
// The plain-text recap the summary model narrates. Pure and dependency-light
// on purpose: since W3 it runs SERVER-SIDE (api/_lib/trackerSession.ts) from
// the saved rows, so every client gets the same text. PRs arrive
// pre-computed (see lib/tracking/records.ts) — the model narrates them, it
// never queries or derives them, keeping token spend to one small completion.

function setLine(weight: string, reps: string, duration: string): string {
  const parts: string[] = [];
  if (weight) parts.push(weight);
  if (reps) parts.push(`× ${reps}`);
  if (duration) parts.push(duration);
  return parts.join(' ');
}

/**
 * The recap's NUTRITION section: the workout day's logged meals with
 * stored-or-derived calories, plus day totals. Empty string when nothing is
 * logged — the model must have nothing to nag about, not a "no meals" line.
 */
export function buildNutritionSection(meals: Meal[]): string {
  if (meals.length === 0) return '';
  const lines = ['', 'NUTRITION logged this day (pre-computed — narrate only, never invent intake):'];
  for (const m of meals) {
    const kcal = mealCalories(m);
    const macros = [
      kcal !== null ? `${kcal} kcal` : null,
      m.proteinG !== undefined ? `P ${m.proteinG}` : null,
      m.carbsG !== undefined ? `C ${m.carbsG}` : null,
      m.fatTotalG !== undefined ? `F ${m.fatTotalG}` : null,
    ].filter(Boolean).join(' · ');
    const context = [m.mealType, m.time].filter(Boolean).join(', ');
    lines.push(`- ${m.title}${context ? ` (${context})` : ''}: ${macros || 'no macros logged'}`);
  }
  const totals = sumDayMacros(meals);
  lines.push(`Day totals: ${totals.calories} kcal · protein ${totals.proteinG}g · carbs ${totals.carbsG}g · fat ${totals.fatTotalG}g`);
  return lines.join('\n');
}

/** Compact plain-text recap of the session — the user message for the model. */
export function buildSessionRecap(
  event: WorkoutEvent,
  groups: TrackedSectionGroup[],
  durationSeconds: number | null,
  prs: PersonalRecord[],
  meals: Meal[] = [],
): string {
  const lines: string[] = [];
  lines.push(`Workout: ${event.title} (${event.type})`);
  lines.push(`Date: ${format(parseISO(event.date), 'EEEE, MMM d, yyyy')}`);
  if (durationSeconds != null) lines.push(`Duration: ${Math.round(durationSeconds / 60)} min`);

  for (const group of groups) {
    lines.push('');
    lines.push(`${group.label}:`);
    for (const tracked of group.exercises) {
      if (tracked.isCardio && tracked.cardio) {
        const c = tracked.cardio;
        const parts: string[] = [];
        if (c.durationMinutes) parts.push(`${c.durationMinutes} min`);
        if (c.distance) parts.push(c.distance);
        if (c.elevationGain) parts.push(`${c.elevationGain} elevation`);
        if (c.avgHeartRate) parts.push(`${c.avgHeartRate} bpm avg`);
        lines.push(`- ${tracked.exercise.name}: ${parts.length ? parts.join(', ') : 'not logged'}`);
        continue;
      }
      const done: string[] = [];
      let skipped = 0;
      for (const set of tracked.sets) {
        if (set.isAutofilled) { skipped += 1; continue; }
        const line = setLine(set.actualWeight, set.actualReps, set.actualDuration);
        if (line) done.push(line);
        else if (!set.isExtra) skipped += 1;
      }
      const summary = done.length ? done.join('; ') : 'no sets logged';
      lines.push(`- ${tracked.exercise.name}: ${summary}${skipped ? ` (${skipped} set${skipped === 1 ? '' : 's'} skipped)` : ''}`);
    }
  }

  lines.push('');
  if (prs.length) {
    lines.push('PERSONAL RECORDS this session (pre-computed and verified — highlight these):');
    for (const pr of prs) {
      lines.push(`- ${pr.exerciseName} (${pr.kind === 'oneRM' ? 'strength' : pr.kind} record): ${describeRecord(pr)}`);
    }
  } else {
    lines.push('No personal records this session.');
  }

  const nutrition = buildNutritionSection(meals);
  if (nutrition) lines.push(nutrition);

  return lines.join('\n');
}
