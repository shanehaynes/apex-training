import type { RecurrenceRule } from './types.js';
import { validateRRule } from './validate.js';

/**
 * Serializes a RecurrenceRule to its canonical RRULE value string (no
 * 'RRULE:' prefix), in canonical key order FREQ;INTERVAL;BYDAY;BYMONTHDAY;
 * COUNT;UNTIL. INTERVAL is omitted when 1, matching how rules are
 * hand-authored in seed data.
 *
 * serializeRRule(parseRRule(s)) === s for every valid canonical input.
 */
export function serializeRRule(rule: RecurrenceRule): string {
  validateRRule(rule);

  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  return parts.join(';');
}
