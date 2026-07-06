import { addDays, format } from 'date-fns';
import type { WorkoutEvent } from '../../types/workout';
import type { OccurrenceOverride } from './types';
import { parseRRule, expandRecurrence, ruleFromLegacyColumns } from '../recurrence';
import { baseIdOf, makeOccurrenceId, occurrenceDateOf } from './occurrence';

// ─── Recurring expansion ──────────────────────────────────────────────────────
// Pure: turns base events + exception keys into the flat occurrence list the
// calendar renders. Kept free of React/Supabase so it is unit-testable.

// Open-ended rules (no COUNT/UNTIL) are capped this far past today.
const OPEN_ENDED_HORIZON_DAYS = 366;

function applyOverride(e: WorkoutEvent, override: OccurrenceOverride | null | undefined): WorkoutEvent {
  if (!override) return e;
  return {
    ...e,
    date:      override.date ?? e.date,
    startTime: override.startTime ?? e.startTime,
    endTime:   override.endTime ?? e.endTime,
  };
}

export function expandRecurringEvents(
  rawEvents: WorkoutEvent[],
  // Keyed by occurrence id (see ./occurrence): null = skip the occurrence,
  // an override = display it at the overridden date/time instead.
  exceptions: Map<string, OccurrenceOverride | null>,
): WorkoutEvent[] {
  const expanded: WorkoutEvent[] = [];
  const rangeEnd = format(addDays(new Date(), OPEN_ENDED_HORIZON_DAYS), 'yyyy-MM-dd');

  for (const base of rawEvents) {
    // The base row itself: a series anchor rescheduled "this occurrence only"
    // carries an override keyed at its own date. (Skips never remove the base
    // row — matching pre-override behavior.)
    expanded.push(applyOverride(base, exceptions.get(makeOccurrenceId(base.id, base.date))));

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
    // series' occurrences. Moves suppress the generated occurrence too —
    // the moved copy is re-emitted below.
    const exdates = new Set<string>();
    const moves: [string, OccurrenceOverride][] = [];
    for (const [key, override] of exceptions) {
      if (baseIdOf(key) !== base.id) continue;
      const date = occurrenceDateOf(key);
      if (!date) continue;
      exdates.add(date);
      if (override && date !== base.date) moves.push([date, override]);
    }

    for (const dateStr of expandRecurrence(rule, base.date, exdates, rangeEnd)) {
      expanded.push({ ...base, id: makeOccurrenceId(base.id, dateStr), date: dateStr, isCompleted: false });
    }

    // Moved occurrences keep their original-date id, so completion state and
    // later edits stay keyed to the same occurrence across moves.
    for (const [origDate, override] of moves) {
      expanded.push(applyOverride(
        { ...base, id: makeOccurrenceId(base.id, origDate), date: origDate, isCompleted: false },
        override,
      ));
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
