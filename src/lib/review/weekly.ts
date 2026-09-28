import { addDays, format, parseISO, startOfISOWeek } from 'date-fns';
import { isMemoryKind, type MemoryKind } from '../coach/memory.js';

// The weekly review as a document (lane D03): the shapes the server returns
// and the client renders, plus the pure shape guard both sides run. The
// server's deeper validation — doctrine lines against the real text, tool
// inputs against the schemas, next-week dates, the caps — lives in
// api/_lib/review/weekly.ts; this module only says what a document IS, so
// the client can refuse a response that is not one before rendering it.
//
// Nothing here is stored in v1: the document is regenerated on demand and
// lives only in the overlay that asked for it.

export type WeeklyVerdict = 'aligned' | 'drifting' | 'contradicted';
export const WEEKLY_VERDICTS: readonly WeeklyVerdict[] = ['aligned', 'drifting', 'contradicted'];

/** The two tools a next-week proposal may name — the same inputs the chat's confirm card executes. */
export type NextWeekTool = 'create_event' | 'update_event';
export const NEXT_WEEK_TOOLS: readonly NextWeekTool[] = ['create_event', 'update_event'];

/** The caps the server enforces (the model is told them too). */
export const MEMORY_PROPOSALS_MAX = 3;
export const NEXT_WEEK_MAX = 7;

export interface WeekWindow {
  /** Monday, YYYY-MM-DD. */
  start: string;
  /** Sunday, YYYY-MM-DD, inclusive. */
  end: string;
}

export interface WeeklyMiss {
  eventId: string;
  title: string;
  date: string;
  /** The model's one-line guess at why, when it offers one. */
  why?: string;
}

export interface WeeklyPlanVsDone {
  planned: number;
  completed: number;
  minutesPlanned: number;
  minutesDone: number;
  misses: WeeklyMiss[];
}

export interface WeeklyPhysiology {
  summary: string;
  flags: string[];
}

export interface WeeklyDoctrine {
  topic: string;
  /** One line quoted from the topic — the server proves it occurs there. */
  line: string;
  verdict: WeeklyVerdict;
  note: string;
}

export interface WeeklyMemoryProposal {
  kind: MemoryKind;
  content: string;
  why: string;
}

export interface WeeklyNextWeekItem {
  tool: NextWeekTool;
  /** A create_event / update_event input in the exact shape the tool takes. */
  input: Record<string, unknown>;
  why: string;
}

export interface WeeklyReviewDocument {
  week: WeekWindow;
  planVsDone: WeeklyPlanVsDone;
  physiology: WeeklyPhysiology;
  doctrine: WeeklyDoctrine | null;
  memoryProposals: WeeklyMemoryProposal[];
  nextWeek: WeeklyNextWeekItem[];
  /** One sentence. */
  headline: string;
}

/** What POST /api/weekly-review answers. */
export interface WeeklyReviewResponse {
  document: WeeklyReviewDocument;
  /** The coach model the document was generated on — the badge the view shows. */
  model: { id: string; label: string; badge: string };
  /** Sections the server dropped or trimmed, one line each. */
  warnings: string[];
  generatedAt: string;
}

// ─── Weeks ───────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = parseISO(value);
  return !Number.isNaN(d.getTime()) && format(d, 'yyyy-MM-dd') === value;
}

/** The ISO week (Monday–Sunday) containing a date. */
export function isoWeekOf(dateIso: string): WeekWindow {
  const monday = startOfISOWeek(parseISO(dateIso));
  return { start: format(monday, 'yyyy-MM-dd'), end: format(addDays(monday, 6), 'yyyy-MM-dd') };
}

export function shiftWeek(week: WeekWindow, weeks: number): WeekWindow {
  return isoWeekOf(format(addDays(parseISO(week.start), 7 * weeks), 'yyyy-MM-dd'));
}

/** "Sep 21 – 27, 2026" — or across months "Sep 28 – Oct 4, 2026". */
export function weekLabel(week: WeekWindow): string {
  const start = parseISO(week.start);
  const end = parseISO(week.end);
  const sameMonth = format(start, 'yyyy-MM') === format(end, 'yyyy-MM');
  return sameMonth
    ? `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`
    : `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`;
}

// ─── Shape guard ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function isMiss(value: unknown): value is WeeklyMiss {
  return isRecord(value) && isString(value.eventId) && isString(value.title) && isString(value.date)
    && (value.why === undefined || isString(value.why));
}

function isPlanVsDone(value: unknown): value is WeeklyPlanVsDone {
  return isRecord(value)
    && isCount(value.planned) && isCount(value.completed)
    && isCount(value.minutesPlanned) && isCount(value.minutesDone)
    && Array.isArray(value.misses) && value.misses.every(isMiss);
}

function isPhysiology(value: unknown): value is WeeklyPhysiology {
  return isRecord(value) && isString(value.summary) && isStringArray(value.flags);
}

export function isWeeklyVerdict(value: unknown): value is WeeklyVerdict {
  return isString(value) && (WEEKLY_VERDICTS as readonly string[]).includes(value);
}

function isDoctrine(value: unknown): value is WeeklyDoctrine {
  return isRecord(value) && isString(value.topic) && isString(value.line)
    && isWeeklyVerdict(value.verdict) && isString(value.note);
}

function isMemoryProposal(value: unknown): value is WeeklyMemoryProposal {
  return isRecord(value) && isMemoryKind(value.kind) && isString(value.content) && isString(value.why);
}

export function isNextWeekTool(value: unknown): value is NextWeekTool {
  return isString(value) && (NEXT_WEEK_TOOLS as readonly string[]).includes(value);
}

function isNextWeekItem(value: unknown): value is WeeklyNextWeekItem {
  return isRecord(value) && isNextWeekTool(value.tool) && isRecord(value.input) && isString(value.why);
}

/**
 * True when `value` has exactly the document's shape: every section present
 * with the right types and enums. Caps and semantics (does the doctrine line
 * occur, is the event id real) are the server's; a document that passes here
 * is safe to render, not necessarily true.
 */
export function isWeeklyReviewDocument(value: unknown): value is WeeklyReviewDocument {
  if (!isRecord(value)) return false;
  const week = value.week;
  if (!isRecord(week) || !isIsoDate(week.start) || !isIsoDate(week.end)) return false;
  if (!isPlanVsDone(value.planVsDone)) return false;
  if (!isPhysiology(value.physiology)) return false;
  if (value.doctrine !== null && !isDoctrine(value.doctrine)) return false;
  if (!Array.isArray(value.memoryProposals) || !value.memoryProposals.every(isMemoryProposal)) return false;
  if (!Array.isArray(value.nextWeek) || !value.nextWeek.every(isNextWeekItem)) return false;
  return isString(value.headline);
}

/** The response envelope, with the document inside checked by the guard above. */
export function isWeeklyReviewResponse(value: unknown): value is WeeklyReviewResponse {
  if (!isRecord(value) || !isWeeklyReviewDocument(value.document)) return false;
  const model = value.model;
  if (!isRecord(model) || !isString(model.id) || !isString(model.label) || !isString(model.badge)) return false;
  return isStringArray(value.warnings) && isString(value.generatedAt);
}
