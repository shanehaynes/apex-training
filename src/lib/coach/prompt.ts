import { format, parseISO, startOfWeek, endOfWeek, subWeeks, isWithinInterval } from 'date-fns';
import type { ExerciseDefinition, WorkoutEvent } from '../../types/workout';

// The coach's system prompt: live schedule context (with bracketed ids the
// tools reference), the exercise-library name list, plus a 4-week
// completion-rate summary. Pure — computed client-side from ScheduleContext
// data, unit-testable without React.

export function buildSystemPrompt(
  todayEvents: WorkoutEvent[],
  allEvents: WorkoutEvent[],
  today: Date,
  definitions: Iterable<ExerciseDefinition> = [],
): string {
  const dayName = format(today, 'EEEE, MMMM d, yyyy');

  // Include IDs so Claude can reference them in tool calls
  const todayStr = todayEvents.length === 0
    ? 'No workouts scheduled.'
    : todayEvents.map(e => {
        const time = e.startTime ? ` at ${e.startTime}` : '';
        const done = e.isCompleted ? ' ✓' : '';
        return `• [${e.id}] ${e.title} (${e.estimatedDuration} min)${time}${done}`;
      }).join('\n');

  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const weekEnd   = endOfWeek(today,   { weekStartsOn: 1 });
  const thisWeek  = allEvents.filter(e => {
    const d = parseISO(e.date);
    return isWithinInterval(d, { start: weekStart, end: weekEnd });
  });

  const weekStr = thisWeek.length === 0
    ? 'No workouts this week.'
    : thisWeek.map(e => {
        const dayLabel = format(parseISO(e.date), 'EEE MMM d');
        const done = e.isCompleted ? '✓' : '○';
        return `${done} [${e.id}] ${dayLabel} — ${e.title} (${e.estimatedDuration} min)`;
      }).join('\n');

  const pastEvents: WorkoutEvent[] = [];
  for (let i = 1; i <= 4; i++) {
    const ref = subWeeks(today, i);
    const s  = startOfWeek(ref, { weekStartsOn: 1 });
    const en = endOfWeek(ref,   { weekStartsOn: 1 });
    pastEvents.push(...allEvents.filter(e => {
      const d = parseISO(e.date);
      return isWithinInterval(d, { start: s, end: en });
    }));
  }
  const completedPast  = pastEvents.filter(e => e.isCompleted).length;
  const completionRate = pastEvents.length > 0
    ? Math.round((completedPast / pastEvents.length) * 100)
    : 0;

  // Inline while the library is small (~69 names). If it outgrows ~150,
  // switch to a search_exercises tool instead (spec §8 Q6).
  const libraryNames = [...definitions]
    .filter(d => !d.archivedAt)
    .map(d => d.canonicalName)
    .sort((a, b) => a.localeCompare(b));
  const librarySection = libraryNames.length === 0 ? '' : `

EXERCISE LIBRARY (canonical names):
${libraryNames.join(' · ')}
When adding exercises to events, use EXACTLY these names to reference them. Any other name creates a NEW library entry — do that only for a genuinely new movement, never as a variant spelling of one above. Renaming or editing form cues on a library entry: use update_exercise_definition (propagates everywhere).`;

  return `You are a terse, high-signal fitness coach in the user's training app. You have live schedule access and can create, update, or delete events via tools.

Today: ${dayName}

TODAY (IDs in brackets):
${todayStr}

THIS WEEK (IDs in brackets):
${weekStr}

LAST 4 WEEKS: ${completedPast}/${pastEvents.length} completed (${completionRate}%)${librarySection}

EXERCISE AUTHORING RULES (when creating or editing events):
- One movement per exercise entry. Never combine two movements into one entry (e.g. "Wrist Twist + Reverse Wrist Curl" must be two entries). Named single lifts like Clean and Jerk stay one entry.
- Unilateral (single-arm/single-leg/per-side) exercises: rep counts are per side, and the reps string must say so explicitly — "5 each leg", "15 each arm", "10 each side" — never a bare number. If a count is intentionally a combined total, write "total".
- Timed holds go in duration (e.g. "20–30 sec each side"), not reps.
- List exercises in the order they are performed.

STYLE:
- Maximum information per word. No filler, no affirmations, no "Great question!", no restating what the user said.
- Skip pleasantries. Lead with the answer or the action.
- Numbers and specifics over vague encouragement.
- Short sentences. Fragments fine.
- Daily briefing: 2–3 tight sentences max.
- Use tools with the exact bracketed IDs. For recurring events (IDs with "__"): confirm scope (one instance vs. full series) before calling delete_event.`;
}
