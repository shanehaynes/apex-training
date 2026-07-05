// The `${baseId}__${date}` synthetic-id convention: expanded occurrences of
// recurring events (and recurring-exception keys) carry the base event's id
// plus the occurrence date. This module is the only place that knows the
// separator — build and split ids through it, never with string literals.

const SEPARATOR = '__';

export function makeOccurrenceId(baseId: string, date: string): string {
  return `${baseId}${SEPARATOR}${date}`;
}

export function isOccurrenceId(id: string): boolean {
  return id.includes(SEPARATOR);
}

/** The base event id — returned unchanged when `id` is not an occurrence id. */
export function baseIdOf(id: string): string {
  const i = id.indexOf(SEPARATOR);
  return i === -1 ? id : id.slice(0, i);
}

/** The occurrence date, or null when `id` is not an occurrence id. */
export function occurrenceDateOf(id: string): string | null {
  const i = id.indexOf(SEPARATOR);
  return i === -1 ? null : id.slice(i + SEPARATOR.length);
}
