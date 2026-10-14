import { addDays, format, parseISO, startOfISOWeek } from 'date-fns';
import { isMemoryKind, type MemoryKind } from '../coach/memory.js';
import type { HrvSummary, LoadSummary, WeekTonnage, ZoneMethod, ZoneMinutes } from '../physiology/types.js';

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

/** One PR set in the reviewed week, described in the athlete's unit. */
export interface WeeklyStatsPr {
  exerciseName: string;
  kind: 'oneRM' | 'duration' | 'reps' | 'distance' | 'elevation' | 'send';
  date: string;
  /** "est. best single lift 216 (190 × 5), up from 206 on Jun 12" — describeRecordForPeople. */
  detail: string;
}

/**
 * The week's computed numbers, no model involved: sent with every response,
 * key or no key. Physiology is the panel (src/lib/physiology) computed as of
 * `asOf` — the reviewed week's Sunday, or today while that week is still
 * running — so an old week shows that week's load, not this one's.
 */
export interface WeeklyReviewStats {
  week: WeekWindow;
  asOf: string;
  /** Plan vs done as computePlanVsDone counts it; misses carry no `why`. */
  plan: WeeklyPlanVsDone;
  prs: WeeklyStatsPr[];
  /** The athlete's display unit; every tonnage figure stays in pounds. */
  weightUnit: 'lb' | 'kg';
  physiology: {
    /** Acute 7 d vs chronic 28 d weekly average; null without data. */
    load: LoadSummary | null;
    hrv: HrvSummary | null;
    /** Z1…Z5 minutes in the reviewed week; null when no session yielded a reading. */
    zoneMinutes: ZoneMinutes | null;
    zoneMethod: ZoneMethod | null;
    /** The reviewed week and the four before it, oldest first; empty without logged sets. */
    tonnageByWeek: WeekTonnage[];
  };
}

/**
 * What POST /api/weekly-review answers. Without an Anthropic key the server
 * still answers 200: `document` and `model` are null and `stats` carries
 * the week. `stats` is optional only for a response from a server that
 * predates it; this one always sends it.
 */
export interface WeeklyReviewResponse {
  document: WeeklyReviewDocument | null;
  /** The coach model the document was generated on — the badge the view shows; null when none ran. */
  model: { id: string; label: string; badge: string } | null;
  stats?: WeeklyReviewStats;
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

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNullableNumber = (v: unknown): v is number | null => v === null || isNumber(v);

function isLoad(value: unknown): value is LoadSummary {
  return isRecord(value) && (value.source === 'trainingLoad' || value.source === 'cardioMinutes')
    && isNumber(value.acute7d) && isNumber(value.chronicWeeklyAvg28d) && isNullableNumber(value.ratio);
}

function isHrv(value: unknown): value is HrvSummary {
  return isRecord(value) && isNullableNumber(value.mean7d) && isNumber(value.mean28d);
}

function isZoneMinutes(value: unknown): value is ZoneMinutes {
  return Array.isArray(value) && value.length === 5 && value.every(isCount);
}

function isStatsPr(value: unknown): value is WeeklyStatsPr {
  return isRecord(value) && isString(value.exerciseName) && isString(value.kind)
    && isIsoDate(value.date) && isString(value.detail);
}

/** True when `value` is the computed stats payload, every section typed. */
export function isWeeklyReviewStats(value: unknown): value is WeeklyReviewStats {
  if (!isRecord(value)) return false;
  const week = value.week;
  if (!isRecord(week) || !isIsoDate(week.start) || !isIsoDate(week.end) || !isIsoDate(value.asOf)) return false;
  if (!isPlanVsDone(value.plan) || !Array.isArray(value.prs) || !value.prs.every(isStatsPr)) return false;
  if (value.weightUnit !== 'lb' && value.weightUnit !== 'kg') return false;
  const p = value.physiology;
  if (!isRecord(p)) return false;
  if (p.load !== null && !isLoad(p.load)) return false;
  if (p.hrv !== null && !isHrv(p.hrv)) return false;
  if (p.zoneMinutes !== null && !isZoneMinutes(p.zoneMinutes)) return false;
  if (p.zoneMethod !== null && p.zoneMethod !== 'device' && p.zoneMethod !== 'avgHr' && p.zoneMethod !== 'mixed') return false;
  return Array.isArray(p.tonnageByWeek)
    && p.tonnageByWeek.every(w => isRecord(w) && isIsoDate(w.weekStart) && isNullableNumber(w.tonnageLb));
}

/**
 * The response envelope. Either a document (checked by the guard above)
 * with its model, or — the keyless answer — no document, no model and the
 * stats. Stats, when present, must be well formed either way.
 */
export function isWeeklyReviewResponse(value: unknown): value is WeeklyReviewResponse {
  if (!isRecord(value)) return false;
  if (value.stats !== undefined && !isWeeklyReviewStats(value.stats)) return false;
  if (value.document === null) {
    if (value.model !== null || value.stats === undefined) return false;
  } else {
    if (!isWeeklyReviewDocument(value.document)) return false;
    const model = value.model;
    if (!isRecord(model) || !isString(model.id) || !isString(model.label) || !isString(model.badge)) return false;
  }
  return isStringArray(value.warnings) && isString(value.generatedAt);
}
