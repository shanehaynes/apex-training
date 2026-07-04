import Anthropic from '@anthropic-ai/sdk';
import { format, parseISO } from 'date-fns';
import type { WorkoutEvent } from '../../types/workout';
import type { TrackedSectionGroup } from '../tracking/plan';
import { describeRecord } from '../tracking/records';
import type { PersonalRecord } from '../tracking/records';

// ─── Post-workout coach summary ───────────────────────────────────────────────
// One-shot generation at Finish. PRs arrive pre-computed (see
// lib/tracking/records.ts) — the model narrates them, it never queries or
// derives them, keeping token spend to a single small completion.

const SYSTEM_PROMPT =
  "You are the user's personal training coach reviewing a workout they just finished. " +
  'Write a brief, punchy summary: 2-4 sentences. Acknowledge the work, call out any ' +
  'personal records listed in the recap (they are pre-computed and verified — never ' +
  'invent records that are not listed), and make one pointed observation, e.g. skipped ' +
  'sets, a big jump versus last time, or a strong finish. Speak directly to the user in ' +
  'second person. Plain prose only: no greeting, no sign-off, no markdown, no bullet points.';

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
 * Generate the coach's written summary. Throws when no API key is configured
 * or the request fails — the summary popup degrades to PRs + the completed
 * list in that case.
 */
export async function generateCoachSummary(recap: string): Promise<string> {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined;
  if (!apiKey) throw new Error('VITE_ANTHROPIC_API_KEY not configured');

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: recap }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
  if (!text) throw new Error('Empty summary response');
  return text;
}
