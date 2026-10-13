import { addDays, format, parseISO, startOfWeek } from 'date-fns';
import type { WorkoutEvent } from '../../types/workout';
import type { WorkoutEventRow } from '../db/types';
import { eventToRow } from '../schedule/mapping';
import { isOccurrenceId } from '../schedule/occurrence';

// Pure helpers behind "Duplicate to…" (WorkoutModal) and "Copy last week"
// (CopyWeek): what a copy of an event looks like on the wire, which events
// of a week are copyable, and how a run of sequential inserts is reported.
// No React, no network — the components own the POSTs and the toasts.
//
// A copy always goes through POST /api/events, never /api/workout-draft:
// that door auto-completes and plan-fills anything dated before today, and
// a copy is a plan, never a retro-log.

const ISO = 'yyyy-MM-dd';

/** The POST /api/events body for one copy. */
export type CopyEventBody = Omit<WorkoutEventRow, 'created_at' | 'updated_at' | 'user_id'> & {
  triggered_by: 'user';
};

export interface PlannedCopy {
  source: WorkoutEvent;
  body: CopyEventBody;
}

/** `copy-<uuid>`: never collides with the builder's `ai-`, the template clone's `tpl-`, or a seed slug. */
export function mintCopyId(): string {
  return `copy-${crypto.randomUUID()}`;
}

/**
 * Only a one-off copies. A series base row (isRecurring), any expanded
 * occurrence (`base__date` id — overridden ones included) and a detached
 * occurrence that still carries its id are all skipped: a copy of a series
 * occurrence lands as a one-off from the modal, where the user chose it,
 * never from the week copy, which would silently flatten the series.
 */
export function isCopyable(event: WorkoutEvent): boolean {
  return !event.isRecurring && !isOccurrenceId(event.id);
}

/**
 * A one-off copy of `source` on `date`: same title, type, sport, exercises,
 * duration, difficulty, tags, equipment, description, location, targets,
 * start/end time and template linkage. Dropped: the source id, completion,
 * every recurrence column (null, is_recurring false), and provider
 * provenance — a copy is planned by hand, whatever synced its source.
 */
export function copyBody(source: WorkoutEvent, date: string, id: string): CopyEventBody {
  const row = eventToRow({
    ...source,
    id,
    date,
    isCompleted: false,
    completedAt: undefined,
    isRecurring: false,
    recurrenceRule: undefined,
    recurringPattern: undefined,
    source: undefined,
  });
  return { ...row, triggered_by: 'user' };
}

/** Monday of the week containing `date`, as YYYY-MM-DD. */
export function weekStartIso(date: Date): string {
  return format(startOfWeek(date, { weekStartsOn: 1 }), ISO);
}

export function addIsoDays(iso: string, days: number): string {
  return format(addDays(parseISO(iso), days), ISO);
}

/** Every event (one-offs and occurrences alike) dated in the Monday–Sunday week starting `weekStart`. */
export function eventsInWeek(events: WorkoutEvent[], weekStart: string): WorkoutEvent[] {
  const weekEnd = addIsoDays(weekStart, 6);
  return events.filter(e => e.date >= weekStart && e.date <= weekEnd);
}

export interface WeekCopyPlan {
  /** Monday of the week being copied into. */
  weekStart: string;
  /** Monday of the week being copied from — the one before `weekStart`. */
  sourceWeekStart: string;
  /** One-offs of the source week, each moved to the same weekday + 7. */
  copies: PlannedCopy[];
  /** Series occurrences in the source week, left on their series. */
  skipped: number;
}

/**
 * The copies "Copy last week" would make for the week containing
 * `viewedDate`: every one-off of the previous Monday–Sunday, seven days
 * later. Series occurrences are counted, not copied.
 */
export function planWeekCopy(
  events: WorkoutEvent[],
  viewedDate: Date,
  mintId: () => string = mintCopyId,
): WeekCopyPlan {
  const weekStart = weekStartIso(viewedDate);
  const sourceWeekStart = addIsoDays(weekStart, -7);
  const copies: PlannedCopy[] = [];
  let skipped = 0;
  for (const source of eventsInWeek(events, sourceWeekStart)) {
    if (!isCopyable(source)) { skipped += 1; continue; }
    copies.push({ source, body: copyBody(source, addIsoDays(source.date, 7), mintId()) });
  }
  return { weekStart, sourceWeekStart, copies, skipped };
}

export interface CopyRunResult {
  /** Titles inserted, in order. */
  landed: string[];
  /** Titles not inserted: the one whose POST failed and every one after it. */
  failed: string[];
}

/**
 * Insert the copies one at a time, in order, and stop at the first failure.
 * Not atomic and not pretended to be: the result names what landed and what
 * did not. The ones after the failure are never attempted — a dead network
 * or an expired session would fail them all the same way.
 */
export async function runCopies(
  copies: PlannedCopy[],
  post: (body: CopyEventBody) => Promise<unknown>,
): Promise<CopyRunResult> {
  const landed: string[] = [];
  for (let i = 0; i < copies.length; i++) {
    try {
      await post(copies[i].body);
      landed.push(copies[i].source.title);
    } catch {
      return { landed, failed: copies.slice(i).map(c => c.source.title) };
    }
  }
  return { landed, failed: [] };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The toast after a week copy. Never an empty success: zero copies reads as "Nothing to copy". */
export function weekCopySummary(result: CopyRunResult, skipped: number): string {
  const total = result.landed.length + result.failed.length;
  const skippedNote = skipped > 0 ? `; skipped ${plural(skipped, 'repeating one')}` : '';
  if (total === 0) return `Nothing to copy${skippedNote}`;
  if (result.failed.length === 0) {
    return `Copied ${plural(result.landed.length, 'workout')}${skippedNote} — delete a copy to undo`;
  }
  const landedNote = result.landed.length > 0 ? ` (${result.landed.join(', ')})` : '';
  return `Copied ${result.landed.length} of ${total}${landedNote}. Not copied: ${result.failed.join(', ')} — try again`;
}
