import { format, parseISO } from 'date-fns';
import { postJson } from '../api';
import type { WorkoutEvent } from '../../types/workout';
import type { TrackedSectionGroup } from '../tracking/plan';
import { describeRecord } from '../tracking/records';
import type { PersonalRecord } from '../tracking/records';

// ─── Post-workout coach summary ───────────────────────────────────────────────
// One-shot generation at Finish, proxied through /api/coach-summary so the
// Anthropic key stays server-side. PRs arrive pre-computed (see
// lib/tracking/records.ts) — the model narrates them, it never queries or
// derives them, keeping token spend to a single small completion.

function setLine(weight: string, reps: string, duration: string): string {
  const parts: string[] = [];
  if (weight) parts.push(weight);
  if (reps) parts.push(`× ${reps}`);
  if (duration) parts.push(duration);
  return parts.join(' ');
}

/** Compact plain-text recap of the session — the user message for the model. */
export function buildSessionRecap(
  event: WorkoutEvent,
  groups: TrackedSectionGroup[],
  durationSeconds: number | null,
  prs: PersonalRecord[],
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

  return lines.join('\n');
}

/**
 * Generate the coach's written summary via /api/coach-summary. Throws when
 * the request fails or comes back empty — the summary popup degrades to
 * PRs + the completed list in that case.
 */
export async function generateCoachSummary(recap: string): Promise<string> {
  const data = await postJson<{ text?: string }>('/api/coach-summary', { recap }, 'Coach summary');
  if (!data?.text) throw new Error('Empty summary response');
  return data.text;
}
