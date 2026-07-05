import { addDays, format } from 'date-fns';
import type { WorkoutEvent } from '../../types/workout';
import { parseRRule, expandRecurrence, ruleFromLegacyColumns } from '../recurrence';
import { baseIdOf, makeOccurrenceId, occurrenceDateOf } from './occurrence';

// ─── Recurring expansion ──────────────────────────────────────────────────────
// Pure: turns base events + exception keys into the flat occurrence list the
// calendar renders. Kept free of React/Supabase so it is unit-testable.

// Open-ended rules (no COUNT/UNTIL) are capped this far past today.
const OPEN_ENDED_HORIZON_DAYS = 366;

export function expandRecurringEvents(
  rawEvents: WorkoutEvent[],
  exceptions: Set<string>, // occurrence ids (see ./occurrence) to skip
): WorkoutEvent[] {
  const expanded: WorkoutEvent[] = [...rawEvents];
  const rangeEnd = format(addDays(new Date(), OPEN_ENDED_HORIZON_DAYS), 'yyyy-MM-dd');

  for (const base of rawEvents) {
    if (!base.isRecurring || !base.recurrenceRule) continue;

    let rule;
    try {
      rule = parseRRule(base.recurrenceRule);
    } catch (err) {
      console.warn(`[apex] Skipping event ${base.id} — invalid recurrence rule "${base.recurrenceRule}":`, err);
      continue;
    }

    // Exceptions are keyed per series (occurrence ids), so an unrelated
    // event that happens to share a type/date never suppresses this
    // series' occurrences.
    const exdates = new Set<string>();
    for (const key of exceptions) {
      if (baseIdOf(key) !== base.id) continue;
      const date = occurrenceDateOf(key);
      if (date) exdates.add(date);
    }

    for (const dateStr of expandRecurrence(rule, base.date, exdates, rangeEnd)) {
      expanded.push({ ...base, id: makeOccurrenceId(base.id, dateStr), date: dateStr, isCompleted: false });
    }
  }

  return expanded.sort((a, b) => a.date.localeCompare(b.date));
}

// Seed events from schedule.json predate recurrenceRule — derive it from the
// legacy recurringPattern shape so the fallback path expands identically.
export function normalizeSeedEvent(e: WorkoutEvent): WorkoutEvent {
  if (!e.isRecurring || e.recurrenceRule || !e.recurringPattern) return e;
  const rule = ruleFromLegacyColumns(
    e.recurringPattern.frequency,
    e.recurringPattern.daysOfWeek ?? null,
    e.recurringPattern.endDate ?? null,
  );
  return rule ? { ...e, recurrenceRule: rule } : e;
}
