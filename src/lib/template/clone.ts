import type { WorkoutEventRow } from '../db/types';
import { parseRRule, ruleFromLegacyColumns, serializeRRule, WEEKDAYS } from '../recurrence/index.js';
import type { RecurrenceRule } from '../recurrence/index.js';

// Pure helpers for the starter-template copy (api/template-copy.ts).
// Definitions are cloned keeping their ids — exercise_definitions is keyed
// (user_id, id) since phase9 — so the definitionId references inside the
// event JSONB stay valid as-is; only events need fresh globally-unique ids.

interface ExerciseEntryLike {
  definitionId?: unknown;
}

/**
 * Every exercise-library id referenced by the events' warmup / exercises /
 * cooldown JSONB arrays (camelCase payloads), deduplicated.
 */
export function collectDefinitionIds(rows: WorkoutEventRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const section of [row.warmup, row.exercises, row.cooldown]) {
      if (!Array.isArray(section)) continue;
      for (const entry of section) {
        const definitionId = (entry as ExerciseEntryLike | null)?.definitionId;
        if (typeof definitionId === 'string' && definitionId) ids.add(definitionId);
      }
    }
  }
  return [...ids];
}

/** Length of the copied block: four weeks, so every weekday lands exactly 4 times. */
export const TEMPLATE_BLOCK_DAYS = 28;

const DAY_MS = 86_400_000;

// UTC calendar math, as in recurrence/expand.ts — the handler runs on a
// server whose local zone must not move a date.
function toMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addIsoDays(iso: string, days: number): string {
  return toIso(toMs(iso) + days * DAY_MS);
}

/** Last day of the block that starts on `startDate` (inclusive). */
export function templateBlockEnd(startDate: string): string {
  return addIsoDays(startDate, TEMPLATE_BLOCK_DAYS - 1);
}

function hits(rule: RecurrenceRule, sourceDate: string, ms: number): boolean {
  const date = new Date(ms);
  switch (rule.freq) {
    case 'DAILY':
      return true;
    case 'WEEKLY': {
      const days = rule.byDay?.length ? rule.byDay : [WEEKDAYS[new Date(toMs(sourceDate)).getUTCDay()]];
      return days.includes(WEEKDAYS[date.getUTCDay()]);
    }
    case 'MONTHLY': {
      const days = rule.byMonthDay?.length ? rule.byMonthDay : [Number(sourceDate.slice(8, 10))];
      return days.includes(date.getUTCDate());
    }
  }
}

/**
 * Move a template series onto the block starting at `startDate`: the anchor
 * becomes the first day in the block the rule lands on, and the series ends
 * on the block's last day. The source series' own dates are fixed to
 * whenever the template user wrote them, so copying them verbatim hands a new
 * user a plan that may already be over. Null when the row has no rule the
 * engine supports or the rule never lands inside the block.
 */
export function rebaseSeries(
  row: Pick<WorkoutEventRow, 'date' | 'recurrence_rule' | 'recurring_frequency' | 'recurring_days' | 'recurring_end_date'>,
  startDate: string,
): { date: string; recurrence_rule: string; recurring_end_date: string } | null {
  const source = row.recurrence_rule
    || ruleFromLegacyColumns(row.recurring_frequency, row.recurring_days, row.recurring_end_date);
  if (!source) return null;
  let rule: RecurrenceRule;
  try {
    rule = parseRRule(source);
  } catch {
    return null;
  }

  const end = templateBlockEnd(startDate);
  let anchor: string | null = null;
  for (let ms = toMs(startDate); ms <= toMs(end); ms += DAY_MS) {
    if (hits(rule, row.date, ms)) { anchor = toIso(ms); break; }
  }
  if (!anchor) return null;

  const { count: _count, ...rest } = rule;
  return {
    date: anchor,
    recurrence_rule: serializeRRule({ ...rest, until: end }),
    recurring_end_date: end,
  };
}

/**
 * Re-identify an event row for the target user, rebased onto the block
 * starting at `startDate` (see rebaseSeries): fresh id and owner, DB-owned
 * timestamps dropped so insert defaults restamp them. template_id is dropped
 * too — it references the SOURCE user's workout_templates partition, and a
 * dangling cross-user reference would poison the copy's score-history
 * grouping (the scoring_type/time_cap_minutes snapshot columns are plain
 * values, so they clone as-is).
 */
export function cloneEventRow(
  row: WorkoutEventRow,
  newId: string,
  userId: string,
  startDate: string,
): Omit<WorkoutEventRow, 'created_at' | 'updated_at'> | null {
  const rebased = rebaseSeries(row, startDate);
  if (!rebased) return null;
  const { created_at: _created, updated_at: _updated, template_id: _template, ...rest } = row;
  return { ...rest, ...rebased, is_recurring: true, id: newId, user_id: userId };
}
