import type { WorkoutEvent } from '../../types/workout';
import type { TrainingBlock } from '../../types/blocks';

// Coach annotations: the pure half. A note the coach pins to a day, an event
// occurrence or a training block (supabase/migrations/phaseXX_coach_annotations.sql),
// rendered by the calendar as a chip where the target lives. This module is
// shared by the handler (api/_lib/handlers/coachAnnotations.ts validates
// against these sets) and the client (the context indexes with these
// helpers), so the vocabulary is written once. It imports nothing at runtime
// on purpose: the handler reaches it through api/'s Node ESM graph.

export const ANNOTATION_TARGET_KINDS = ['day', 'event', 'block'] as const;
export type AnnotationTargetKind = (typeof ANNOTATION_TARGET_KINDS)[number];

export const ANNOTATION_SEVERITIES = ['info', 'caution', 'alert'] as const;
export type AnnotationSeverity = (typeof ANNOTATION_SEVERITIES)[number];

export const ANNOTATION_AUTHORS = ['coach', 'reflection', 'user'] as const;
export type AnnotationAuthor = (typeof ANNOTATION_AUTHORS)[number];

/** Matches the table's check constraint: a chip, not an essay. */
export const ANNOTATION_BODY_MAX = 400;

/** How much of the body a chip shows before the title attribute takes over. */
export const ANNOTATION_CHIP_CHARS = 40;

/** Widest a target_id gets: an occurrence id is `${baseId}__${date}`, and
 *  base ids are uuids or short seed slugs. Anything longer is not an id. */
export const ANNOTATION_TARGET_ID_MAX = 200;

/** One note, as /api/coach-annotations reports it. */
export interface CoachAnnotation {
  id: string;
  target_kind: AnnotationTargetKind;
  target_id: string;
  body: string;
  severity: AnnotationSeverity;
  created_by: AnnotationAuthor;
  created_at: string;
  dismissed_at: string | null;
}

/** What a writer supplies; the server mints id, author and timestamps. */
export interface NewCoachAnnotation {
  target_kind: AnnotationTargetKind;
  target_id: string;
  body: string;
  severity?: AnnotationSeverity;
}

export function isTargetKind(value: unknown): value is AnnotationTargetKind {
  return typeof value === 'string' && (ANNOTATION_TARGET_KINDS as readonly string[]).includes(value);
}

export function isSeverity(value: unknown): value is AnnotationSeverity {
  return typeof value === 'string' && (ANNOTATION_SEVERITIES as readonly string[]).includes(value);
}

export function isAuthor(value: unknown): value is AnnotationAuthor {
  return typeof value === 'string' && (ANNOTATION_AUTHORS as readonly string[]).includes(value);
}

// ── Target ids ───────────────────────────────────────────────────────────────

const DAY_ID_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a 'YYYY-MM-DD' that names a real calendar day. */
export function isDayId(value: string): boolean {
  if (!DAY_ID_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The day target for a Date (local calendar day) or an existing 'YYYY-MM-DD'. */
export function dayTargetId(date: Date | string): string {
  if (typeof date === 'string') return date;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The event target: the occurrence id the calendar renders (`base__date`
 *  for a recurring instance), never the base id — a note is about one
 *  Tuesday, not every Tuesday. */
export function eventTargetId(event: Pick<WorkoutEvent, 'id'>): string {
  return event.id;
}

export function blockTargetId(block: Pick<TrainingBlock, 'id'>): string {
  return block.id;
}

/**
 * Why a (kind, id) pair is not a target, or null when it is. Each kind has
 * its own id shape, so a day that is not a date or a block that is not a
 * uuid is caught here rather than stored and never matched.
 */
export function targetProblem(kind: AnnotationTargetKind, id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'target_id must be a non-empty string';
  if (id.length > ANNOTATION_TARGET_ID_MAX) return 'target_id is too long';
  if (kind === 'day' && !isDayId(id)) return 'a day target_id must be YYYY-MM-DD';
  if (kind === 'block' && !UUID_RE.test(id)) return 'a block target_id must be a uuid';
  return null;
}

/** The body as stored, or why it cannot be. Trimmed: a note of whitespace
 *  would pass the length check and render an empty chip. */
export function normalizeBody(body: unknown): { body: string } | { reason: string } {
  if (typeof body !== 'string') return { reason: 'body must be a string' };
  const trimmed = body.trim();
  if (trimmed.length === 0) return { reason: 'body must not be empty' };
  if (trimmed.length > ANNOTATION_BODY_MAX) return { reason: `body must be at most ${ANNOTATION_BODY_MAX} characters` };
  return { body: trimmed };
}

// ── Rendering helpers ────────────────────────────────────────────────────────

/**
 * The chip's text: the body collapsed to one line and cut to `max` chars at
 * a word boundary where one is near, with an ellipsis when anything was
 * dropped. The full body goes in the title attribute.
 */
export function chipText(body: string, max = ANNOTATION_CHIP_CHARS): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break at a word when the word boundary keeps most of the width;
  // otherwise a single long token would leave a near-empty chip.
  const head = lastSpace >= max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

const SEVERITY_RANK: Record<AnnotationSeverity, number> = { alert: 0, caution: 1, info: 2 };

/** Lower sorts first: an alert outranks a caution outranks a remark. */
export function severityRank(severity: AnnotationSeverity): number {
  return SEVERITY_RANK[severity];
}

/** Most severe first, then oldest first — a stable reading order for a strip
 *  and the order a cell's "first two" are chosen in. */
export function sortAnnotations(list: readonly CoachAnnotation[]): CoachAnnotation[] {
  return [...list].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) || a.created_at.localeCompare(b.created_at));
}

/** The severity an inline marker takes for a target with several notes. */
export function maxSeverity(list: readonly CoachAnnotation[]): AnnotationSeverity | null {
  let best: AnnotationSeverity | null = null;
  for (const a of list) {
    if (best === null || severityRank(a.severity) < severityRank(best)) best = a.severity;
  }
  return best;
}

export interface AnnotationIndex {
  day: Map<string, CoachAnnotation[]>;
  event: Map<string, CoachAnnotation[]>;
  block: Map<string, CoachAnnotation[]>;
}

/** Live notes bucketed by kind and target, each bucket in reading order. */
export function indexAnnotations(list: readonly CoachAnnotation[]): AnnotationIndex {
  const index: AnnotationIndex = { day: new Map(), event: new Map(), block: new Map() };
  for (const a of sortAnnotations(list)) {
    if (a.dismissed_at) continue;
    const bucket = index[a.target_kind];
    const existing = bucket.get(a.target_id);
    if (existing) existing.push(a);
    else bucket.set(a.target_id, [a]);
  }
  return index;
}

/**
 * The GET response, defensively. The mock profile answers every unknown
 * /api route with `{ ok: true }`, and a stale server returns nothing shaped
 * like a list — both must read as "no notes", never as a crash in a render
 * path. Rows that fail the vocabulary are dropped one at a time.
 */
export function parseAnnotationList(payload: unknown): CoachAnnotation[] {
  if (!payload || typeof payload !== 'object') return [];
  const list = (payload as { annotations?: unknown }).annotations;
  if (!Array.isArray(list)) return [];
  const out: CoachAnnotation[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !isTargetKind(r.target_kind) || typeof r.target_id !== 'string') continue;
    if (typeof r.body !== 'string' || !isSeverity(r.severity)) continue;
    out.push({
      id: r.id,
      target_kind: r.target_kind,
      target_id: r.target_id,
      body: r.body,
      severity: r.severity,
      created_by: isAuthor(r.created_by) ? r.created_by : 'coach',
      created_at: typeof r.created_at === 'string' ? r.created_at : '',
      dismissed_at: typeof r.dismissed_at === 'string' ? r.dismissed_at : null,
    });
  }
  return out;
}
