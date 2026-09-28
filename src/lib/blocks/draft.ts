import { addDays, format, getISODay, parseISO, startOfISOWeek } from 'date-fns';
import { BLOCK_PHASES } from '../../types/blocks.js';
import type { BlockPhase, Objective, TrainingBlock, WeeklyTargets } from '../../types/blocks';
import { blockWeeks } from './period.js';
import { validateBlock } from './validate.js';
import { MAX_CYCLE_BLOCKS } from './cadence.js';

// ─── The block planner's draft (coach initiative, E01 · decision D-C07) ───────
// The coach's planner mode edits a BLOCK DRAFT — one or more contiguous blocks
// with phases, dates and weekly targets — through a single reducer tool,
// update_block_draft. Nothing here persists: the athlete presses Apply, which
// calls the existing createBlocks (atomic, ≤ 24) or updateBlock with
// triggered_by 'user'. The planner never writes a block itself, so the
// "gate the non-'user' path" note in api/_lib/trainingBlocks.ts stays true.
//
// Pure, React-free, `.js` specifiers: api/_lib/coach/context.ts describes the
// draft for the prompt and api/_lib/handlers/coachTool.ts reduces it for
// iOS, so this file sits in the API's runtime import graph.
//
// applyBlockDraftUpdate follows the update_workout_draft contract
// (src/lib/analytics/draft.ts, "Coach reducer"): partial input, per-field
// guards, every violation collected into ONE instructive error that becomes
// the tool_result verbatim, and a summary of what landed so the model knows.

export type BlockDraftItem = Omit<TrainingBlock, 'id'>;

export interface BlockDraft {
  /** The block being replaced when the planner opened from one block's
   *  detail; null when the draft creates new blocks. */
  editingId: string | null;
  blocks: BlockDraftItem[];
}

/** What the reducer needs beyond the draft: the athlete's blocks (for
 *  overlap), their objectives (for objective_id), and the calendar date. */
export interface BlockDraftContext {
  existing: TrainingBlock[];
  objectives: Objective[];
  today: Date;
}

/** The tool input, typed loosely: every guard runs inside the reducer. */
export interface BlockDraftUpdateInput {
  blocks?: unknown;
}

/**
 * A fresh draft with no blocks. `today` is the planner's calendar date; an
 * empty draft has nothing dated to fill from it, so it is accepted for
 * symmetry with emptyDraft(date) in the builder and otherwise unused — the
 * reducer takes the date it needs through its own ctx.
 */
export function emptyBlockDraft(_today: Date): BlockDraft {
  return { editingId: null, blocks: [] };
}

/** The draft the planner opens with from one block's detail: that block,
 *  marked as the one being edited. */
export function draftFromBlock(block: TrainingBlock): BlockDraft {
  const { id, ...item } = block;
  return { editingId: id, blocks: [{ ...item, weeklyTargets: { ...item.weeklyTargets } }] };
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────
// The tool speaks snake_case with an INCLUSIVE end_date (a Sunday), the way
// the block editor's form does; the stored block is camelCase with an
// exclusive end (the next Monday). The mapping lives here exactly once.

const TARGET_KEYS = {
  cardio_minutes:       'cardioMinutes',
  vert:                 'vert',
  distance:             'distance',
  strength_sessions:    'strengthSessions',
  climbing_sessions:    'climbingSessions',
  long_session_minutes: 'longSessionMinutes',
} as const;
type TargetInputKey = keyof typeof TARGET_KEYS;
const TARGET_INPUT_KEYS = Object.keys(TARGET_KEYS) as TargetInputKey[];
const TARGET_LABELS: Record<keyof WeeklyTargets, TargetInputKey> = {
  cardioMinutes: 'cardio_minutes',
  vert: 'vert',
  distance: 'distance',
  strengthSessions: 'strength_sessions',
  climbingSessions: 'climbing_sessions',
  longSessionMinutes: 'long_session_minutes',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(parseISO(value).getTime());
}

/** The Monday that opens the ISO week containing `date`. */
export function mondayOf(date: Date): string {
  return format(startOfISOWeek(date), 'yyyy-MM-dd');
}

/** The stored exclusive end for an inclusive last day. */
export function toExclusiveEnd(inclusive: string): string {
  return format(addDays(parseISO(inclusive), 1), 'yyyy-MM-dd');
}

/** The inclusive last day (a Sunday) for a stored exclusive end. */
export function toInclusiveEnd(exclusive: string): string {
  return format(addDays(parseISO(exclusive), -1), 'yyyy-MM-dd');
}

/** "Oct 6 – Dec 28", or "Dec 1, 2026 – Jan 31, 2027" across a year end. */
export function shortRange(startDate: string, endDateExclusive: string): string {
  const start = parseISO(startDate);
  const end = addDays(parseISO(endDateExclusive), -1);
  return start.getFullYear() === end.getFullYear()
    ? `${format(start, 'MMM d')} – ${format(end, 'MMM d')}`
    : `${format(start, 'MMM d, yyyy')} – ${format(end, 'MMM d, yyyy')}`;
}

/** The targets in the tool's vocabulary: "cardio_minutes 300 · vert 3000 ft". */
export function describeTargets(targets: WeeklyTargets): string {
  const parts: string[] = [];
  for (const key of Object.keys(TARGET_LABELS) as Array<keyof WeeklyTargets>) {
    const value = targets[key];
    if (value === undefined) continue;
    parts.push(typeof value === 'number' ? `${TARGET_LABELS[key]} ${value}` : `${TARGET_LABELS[key]} ${value.value} ${value.unit}`);
  }
  return parts.join(' · ');
}

// ─── Parsing one item ────────────────────────────────────────────────────────

interface ParsedItem {
  /** Fully parsed when every field passed; null when any did not. */
  block: BlockDraftItem | null;
  /** The dates alone, whenever both parsed and end follows start — so the
   *  contiguity, overlap and past-start rules still report on an item whose
   *  other fields failed, and the model sees every problem at once. */
  dates: Pick<BlockDraftItem, 'startDate' | 'endDateExclusive'> | null;
  label: string;
}

function parseTargets(raw: unknown, label: string, errors: string[]): WeeklyTargets | null {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    errors.push(`${label}: weekly_targets must be an object like { cardio_minutes, vert: { value, unit }, … }.`);
    return null;
  }
  const unknown = Object.keys(raw).filter(k => !(TARGET_INPUT_KEYS as string[]).includes(k));
  if (unknown.length) {
    errors.push(`${label}: unknown weekly target${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — the targets are ${TARGET_INPUT_KEYS.join(', ')}.`);
    return null;
  }
  const out: WeeklyTargets = {};
  let ok = true;
  const scalar = (key: TargetInputKey, camel: 'cardioMinutes' | 'strengthSessions' | 'climbingSessions' | 'longSessionMinutes') => {
    const v = raw[key];
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`${label}: ${key} must be a non-negative number.`);
      ok = false;
      return;
    }
    out[camel] = v;
  };
  scalar('cardio_minutes', 'cardioMinutes');
  scalar('strength_sessions', 'strengthSessions');
  scalar('climbing_sessions', 'climbingSessions');
  scalar('long_session_minutes', 'longSessionMinutes');

  const quantity = <U extends string>(key: 'vert' | 'distance', units: readonly U[]) => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (!isObject(v) || typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < 0
      || typeof v.unit !== 'string' || !(units as readonly string[]).includes(v.unit)) {
      errors.push(`${label}: ${key} must be { value: a non-negative number, unit: ${units.map(u => `'${u}'`).join(' | ')} }.`);
      ok = false;
      return null;
    }
    return { value: v.value, unit: v.unit as U };
  };
  const vert = quantity('vert', ['ft', 'm'] as const);
  if (vert) out.vert = vert;
  const distance = quantity('distance', ['mi', 'km'] as const);
  if (distance) out.distance = distance;
  return ok ? out : null;
}

function parseItem(raw: unknown, index: number, ctx: BlockDraftContext, errors: string[]): ParsedItem {
  const fallback = `block ${index + 1}`;
  if (!isObject(raw)) {
    errors.push(`${fallback} must be an object with name, start_date and end_date.`);
    return { block: null, dates: null, label: fallback };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const label = name ? `${fallback} "${name}"` : fallback;
  let ok = true;
  const fail = (message: string) => { errors.push(`${label}: ${message}`); ok = false; };

  if (!name) fail('name is required.');

  let intent = '';
  if (raw.intent !== undefined && raw.intent !== null) {
    if (typeof raw.intent === 'string') intent = raw.intent.trim();
    else fail('intent must be a string.');
  }

  let phase: BlockPhase | undefined;
  if (raw.phase !== undefined && raw.phase !== null) {
    if (typeof raw.phase === 'string' && (BLOCK_PHASES as readonly string[]).includes(raw.phase)) phase = raw.phase as BlockPhase;
    else fail(`phase must be one of ${BLOCK_PHASES.join(', ')}.`);
  }

  let objectiveId: string | undefined;
  if (raw.objective_id !== undefined && raw.objective_id !== null) {
    if (typeof raw.objective_id === 'string' && ctx.objectives.some(o => o.id === raw.objective_id)) {
      objectiveId = raw.objective_id;
    } else {
      const known = ctx.objectives.map(o => `${o.id} (${o.name})`).join(', ');
      fail(`objective_id ${JSON.stringify(raw.objective_id)} names no objective — ${known ? `the athlete's objectives are ${known}` : 'the athlete has no objectives; omit it'}.`);
    }
  }

  let startDate: string | null = null;
  if (!isIsoDate(raw.start_date)) fail('start_date must be a YYYY-MM-DD date.');
  else if (getISODay(parseISO(raw.start_date)) !== 1) {
    fail(`start_date ${raw.start_date} is not a Monday — blocks start on a Monday (the week's is ${mondayOf(parseISO(raw.start_date))}).`);
  } else startDate = raw.start_date;

  let endDateExclusive: string | null = null;
  if (!isIsoDate(raw.end_date)) fail('end_date must be a YYYY-MM-DD date (the block\'s last day, inclusive).');
  else if (getISODay(parseISO(raw.end_date)) !== 7) {
    fail(`end_date ${raw.end_date} is not a Sunday — a block ends on the Sunday that closes its last week.`);
  } else endDateExclusive = toExclusiveEnd(raw.end_date);

  const weeklyTargets = parseTargets(raw.weekly_targets, label, errors);
  if (weeklyTargets === null) ok = false;

  const dates = startDate && endDateExclusive && endDateExclusive > startDate ? { startDate, endDateExclusive } : null;
  if (startDate && endDateExclusive && !dates) fail('A block must end after it starts.');
  if (!ok || !dates || !weeklyTargets) return { block: null, dates, label };

  const block: BlockDraftItem = {
    name, intent, phase, objectiveId, startDate: dates.startDate, endDateExclusive: dates.endDateExclusive, weeklyTargets,
  };
  // Mondays, end after start, ≤ 52 weeks, the targets' own shape guard.
  try {
    validateBlock(block);
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}.`);
    return { block: null, dates, label };
  }
  return { block, dates, label };
}

// ─── The reducer ─────────────────────────────────────────────────────────────

/**
 * Reduce one update_block_draft call onto the draft. `blocks` replaces the
 * whole list. Every rule is a sentence in the one error: 1–24 items; an
 * editing draft holds exactly one; each item validates as a block; items
 * are contiguous and in date order; none overlaps an existing block (the
 * one being edited excepted); none starts before this week's Monday unless
 * it is the one being edited.
 */
export function applyBlockDraftUpdate(
  draft: BlockDraft,
  input: BlockDraftUpdateInput,
  ctx: BlockDraftContext,
): { draft: BlockDraft; summary: string } | { error: string } {
  // A draft of another shape (a chart draft posted to the block tool) is the
  // caller's bug, not a tool_result: throw, like the other reducers do, so
  // the coach-tool handler answers 400.
  requireBlockDraft(draft);
  if (input.blocks === undefined) {
    return { error: 'Nothing recognized in the update — pass `blocks`, the whole list of blocks the draft should hold.' };
  }
  if (!Array.isArray(input.blocks)) {
    return { error: '`blocks` must be an array of block items ({ name, start_date, end_date, phase?, intent?, objective_id?, weekly_targets? }).' };
  }

  const errors: string[] = [];
  const raw = input.blocks as unknown[];
  if (raw.length < 1) errors.push('The draft needs at least one block.');
  if (raw.length > MAX_CYCLE_BLOCKS) errors.push(`A plan cannot hold more than ${MAX_CYCLE_BLOCKS} blocks (got ${raw.length}) — shorten it.`);
  if (draft.editingId && raw.length !== 1) {
    errors.push(`This draft edits one existing block, so pass exactly one item (got ${raw.length}).`);
  }

  const parsed = raw.map((item, i) => parseItem(item, i, ctx, errors));

  // Contiguous, in date order: each block starts the day after the previous ends.
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1].dates;
    const cur = parsed[i].dates;
    if (!prev || !cur) continue;
    if (cur.startDate !== prev.endDateExclusive) {
      errors.push(
        `Blocks must be contiguous and in date order: ${parsed[i].label} should start on ${prev.endDateExclusive}, ` +
        `the day after ${parsed[i - 1].label} ends, but starts ${cur.startDate}.`,
      );
    }
  }

  // No overlap with what already exists — minus the block this draft replaces.
  const others = ctx.existing.filter(b => b.id !== draft.editingId);
  const thisMonday = mondayOf(ctx.today);
  for (const { dates: block, label } of parsed) {
    if (!block) continue;
    const hit = others.find(b => block.startDate < b.endDateExclusive && b.startDate < block.endDateExclusive);
    if (hit) {
      errors.push(
        `${label} (${shortRange(block.startDate, block.endDateExclusive)}) overlaps the existing block "${hit.name}" ` +
        `(${shortRange(hit.startDate, hit.endDateExclusive)}) — blocks cannot overlap; plan around it.`,
      );
    }
    if (!draft.editingId && block.startDate < thisMonday) {
      errors.push(`${label} starts ${block.startDate}, before this week's Monday (${thisMonday}) — new blocks start this week or later.`);
    }
  }

  if (errors.length) return { error: errors.join(' ') };

  const blocks = parsed.map(p => p.block!);
  const next: BlockDraft = { editingId: draft.editingId, blocks };
  return { draft: next, summary: summarize(blocks) };
}

function summarize(blocks: BlockDraftItem[]): string {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const phases = blocks.map(b => `${b.phase ?? b.name} ${blockWeeks(b)}w`).join(' · ');
  const count = `${blocks.length} block${blocks.length === 1 ? '' : 's'}`;
  return `Block draft updated: ${count}, ${shortRange(first.startDate, last.endDateExclusive)} (${phases}). The user reviews and presses Apply.`;
}

// ─── Descriptions for the prompt ─────────────────────────────────────────────

function requireBlockDraft(draft: unknown): BlockDraft {
  if (!isObject(draft) || !('editingId' in draft) || !Array.isArray(draft.blocks)) {
    throw new Error('not a block draft');
  }
  if (draft.editingId !== null && typeof draft.editingId !== 'string') throw new Error('not a block draft');
  for (const item of draft.blocks) {
    if (!isObject(item) || typeof item.name !== 'string' || typeof item.startDate !== 'string' || typeof item.endDateExclusive !== 'string') {
      throw new Error('not a block draft');
    }
  }
  return draft as unknown as BlockDraft;
}

/**
 * Compact text form of the draft for the planner's prompt, in the tool's own
 * vocabulary (inclusive end_date) so the model can round-trip what it reads.
 * Throws on anything that is not a block draft — context.ts turns that into
 * a 400.
 */
export function describeBlockDraft(input: unknown): string {
  const draft = requireBlockDraft(input);
  const lines: string[] = [];
  if (draft.editingId) lines.push(`Editing existing block ${draft.editingId} — the draft holds exactly its replacement.`);
  if (draft.blocks.length === 0) {
    lines.push('(no blocks yet)');
    return lines.join('\n');
  }
  draft.blocks.forEach((b, i) => {
    const weeks = blockWeeks(b);
    const head = [
      `${i + 1}. ${b.name}`,
      b.phase ? `phase ${b.phase}` : 'no phase',
      `start_date ${b.startDate}`,
      `end_date ${toInclusiveEnd(b.endDateExclusive)} (${weeks} week${weeks === 1 ? '' : 's'})`,
      b.objectiveId ? `objective_id ${b.objectiveId}` : null,
    ].filter(Boolean).join(' · ');
    lines.push(head);
    if (b.intent) lines.push(`   intent: ${b.intent}`);
    const targets = describeTargets(b.weeklyTargets ?? {});
    lines.push(`   weekly_targets: ${targets || '(none)'}`);
  });
  return lines.join('\n');
}

/** The athlete's existing blocks, one line each, for <existing_blocks>. */
export function describeExistingBlocks(blocks: TrainingBlock[], objectives: Objective[] = []): string {
  if (blocks.length === 0) return '(no blocks yet)';
  return [...blocks]
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map(b => {
      const objective = objectives.find(o => o.id === b.objectiveId);
      const weeks = blockWeeks(b);
      return [
        `- [${b.id}] ${b.name}`,
        b.phase ? `phase ${b.phase}` : null,
        `${b.startDate} → ${toInclusiveEnd(b.endDateExclusive)} (${weeks} week${weeks === 1 ? '' : 's'})`,
        objective ? `objective "${objective.name}"` : null,
        describeTargets(b.weeklyTargets) || null,
      ].filter(Boolean).join(' · ');
    })
    .join('\n');
}

/** The athlete's objectives with the ids objective_id takes, for <objectives>. */
export function describeObjectives(objectives: Objective[]): string {
  if (objectives.length === 0) return '(no objectives yet)';
  return objectives
    .map(o => [
      `- [${o.id}] ${o.name}`,
      o.discipline ?? null,
      o.targetDate ? `target ${o.targetDate}` : 'undated',
      o.status,
    ].filter(Boolean).join(' · '))
    .join('\n');
}
