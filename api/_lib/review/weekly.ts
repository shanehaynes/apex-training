import type Anthropic from '@anthropic-ai/sdk';
import { addDays, format, parseISO } from 'date-fns';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchExpandedSchedule } from '../mcp/data.js';
import { fetchPeriodInputs } from '../reviewData.js';
import { fetchPhysiologyInputs } from '../coach/physiology.js';
import { listConfirmed, toPromptEntries } from '../coach/memory.js';
import type { CompletionRow, ObjectiveRow, TrainingBlockRow, WorkoutSessionRow } from '../../../src/lib/db/types.js';
import type { WorkoutEvent } from '../../../src/types/workout.js';
import type { MemoryPromptEntry } from '../../../src/lib/coach/memory.js';
import { isMemoryKind, MEMORY_CONTENT_MAX, MEMORY_KINDS } from '../../../src/lib/coach/memory.js';
import { athleteSection, blockSection, memorySection, sanitizeInlineText, sanitizeUserText } from '../../../src/lib/coach/prompt.js';
import { DOCTRINE_TOPICS, readDoctrine } from '../../../src/lib/coach/doctrine/index.js';
import { createEventSchema, EXERCISE_INPUT_SCHEMA, updateEventSchema } from '../../../src/lib/coach/schemas.js';
import { baseIdOf, isOccurrenceId } from '../../../src/lib/schedule/occurrence.js';
import { computePhysiology, describePhysiology } from '../../../src/lib/physiology/index.js';
import { computeReviewStats, durationMinutesFor, sessionSecondsMap } from '../../../src/lib/review/stats.js';
import type { PeriodStats, StatsPeriod } from '../../../src/lib/review/types.js';
import { rowToBlock, rowToObjective } from '../../../src/lib/blocks/mapping.js';
import { blockCovering, blockPeriod } from '../../../src/lib/blocks/period.js';
import { computeBlockProgress } from '../../../src/lib/blocks/progress.js';
import { buildBlockPromptSummary, type BlockPromptSummary } from '../../../src/lib/blocks/promptSummary.js';
import type { CoachModelOption } from '../../../src/lib/coach/models.js';
import {
  isIsoDate, isNextWeekTool, isoWeekOf, isWeeklyVerdict, MEMORY_PROPOSALS_MAX, NEXT_WEEK_MAX, shiftWeek,
  type WeekWindow, type WeeklyDoctrine, type WeeklyMemoryProposal, type WeeklyMiss, type WeeklyNextWeekItem,
  type WeeklyPlanVsDone, type WeeklyReviewDocument,
} from '../../../src/lib/review/weekly.js';

// The weekly review as a document (lane D03). Three pure stages and one
// fetch:
//
//   fetchWeeklyInputs   the week's occurrences with completion, the period
//                       stats, the physiology panel, the confirmed memory,
//                       the active block, next week's schedule, the library
//   computePlanVsDone   the numbers — planned, done, minutes, misses —
//                       computed here, never by the model (the app's rule)
//   buildWeeklyRecap    the user turn: every input rendered with the same
//                       sanitizers and tagged blocks the chat prompt uses
//   validateWeeklyDocument
//                       the model's JSON against the contract: the numbers
//                       are replaced by ours, the doctrine line must occur
//                       in the topic it names, every next-week input must
//                       fit its tool's schema and name a real event, the
//                       caps hold. Anything that fails is dropped with a
//                       warning, never rendered.
//
// generateWeeklyDocument runs the model call on the caller's own key: one
// streamed request (time-to-headers bounded by anthropicClient.ts, the body
// free to take as long as the function allows), structured output where the
// API accepts it, one correction round on a parse failure while the time
// budget allows, then the handler answers 422.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** Text + thinking together — see api/chat.ts on why thinking needs headroom. */
export const WEEKLY_MAX_TOKENS = 4096;

/** No correction round starts after this much of the function's 60 s is spent. */
const RETRY_BUDGET_MS = 25_000;

const LIBRARY_NAMES_MAX = 150;
const HEADLINE_MAX = 200;
const SUMMARY_MAX = 600;
const FLAG_MAX = 140;
const FLAGS_MAX = 6;
const WHY_MAX = 300;
const NOTE_MAX = 500;
/** A doctrine quote shorter than this could match by accident ("the coach"). */
const DOCTRINE_LINE_MIN = 20;

// ─── Weeks ───────────────────────────────────────────────────────────────────

/**
 * The week under review: `week` (any date inside it) when the caller names
 * one, else the ISO week containing today. Null for a malformed date.
 */
export function resolveWeek(todayIso: string, week: unknown): WeekWindow | null {
  if (week === undefined || week === null || week === '') return isoWeekOf(todayIso);
  return isIsoDate(week) ? isoWeekOf(week) : null;
}

function weekPeriod(window: WeekWindow): StatsPeriod {
  return {
    periodType: 'block',
    startDate: window.start,
    endDateExclusive: format(addDays(parseISO(window.end), 1), 'yyyy-MM-dd'),
    label: `${format(parseISO(window.start), 'MMM d')} – ${format(parseISO(window.end), 'MMM d, yyyy')}`,
    weeksInPeriod: 1,
  };
}

const inWindow = (date: string, w: WeekWindow) => date >= w.start && date <= w.end;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface WeeklyInputs {
  today: string;
  window: WeekWindow;
  nextWeek: WeekWindow;
  /** This week's occurrences, completion state applied, date order. */
  events: WorkoutEvent[];
  /** Next week's occurrences — what update_event proposals may name. */
  nextWeekEvents: WorkoutEvent[];
  /** Every id an update_event may name: next week's occurrence ids and their base ids, nothing else. */
  knownEventIds: Set<string>;
  completions: CompletionRow[];
  sessions: WorkoutSessionRow[];
  stats: PeriodStats<StatsPeriod>;
  /** The rendered <physiology> block, or '' when there is no measured data. */
  physiology: string;
  memories: MemoryPromptEntry[];
  block: BlockPromptSummary | null;
  athlete: { goal?: string; context?: string };
  libraryNames: string[];
}

/** The active block's summary, as the chat prompt carries it; null on any failure. */
async function blockSummary(
  supabase: Admin,
  userId: string,
  todayIso: string,
  occurrences: WorkoutEvent[],
): Promise<BlockPromptSummary | null> {
  try {
    const [blocksRes, objectivesRes] = await Promise.all([
      supabase.from('training_blocks').select('*').eq('user_id', userId).order('start_date', { ascending: true }),
      supabase.from('objectives').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
    ]);
    if (blocksRes.error) throw new Error(blocksRes.error.message);
    if (objectivesRes.error) throw new Error(objectivesRes.error.message);
    const blocks = ((blocksRes.data ?? []) as TrainingBlockRow[]).map(rowToBlock);
    const block = blockCovering(blocks, todayIso);
    if (!block) return null;
    const period = blockPeriod(block);
    const inputs = await fetchPeriodInputs(supabase, userId, period);
    const plannedEvents = occurrences.filter(e => e.date >= period.startDate && e.date < period.endDateExclusive);
    const progress = computeBlockProgress({ ...inputs, block, plannedEvents }, parseISO(todayIso));
    const objectives = ((objectivesRes.data ?? []) as ObjectiveRow[]).map(rowToObjective);
    return buildBlockPromptSummary(progress, objectives.find(o => o.id === block.objectiveId) ?? null);
  } catch (err) {
    console.warn('[api/weekly-review] block summary unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function physiologyBlock(supabase: Admin, userId: string, todayIso: string): Promise<string> {
  try {
    return describePhysiology(computePhysiology(await fetchPhysiologyInputs(supabase, userId, todayIso)));
  } catch (err) {
    console.warn('[api/weekly-review] physiology panel unavailable:', err instanceof Error ? err.message : err);
    return '';
  }
}

async function memoryEntries(supabase: Admin, userId: string): Promise<MemoryPromptEntry[]> {
  try {
    return toPromptEntries(await listConfirmed(supabase, userId));
  } catch (err) {
    console.warn('[api/weekly-review] athlete memory unavailable:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Everything the recap needs, gathered server-side on the service-role
 * client with every query scoped to `userId`. The schedule, completions and
 * stats are required; the panel, the memory and the block are enhancements
 * that degrade to absent.
 */
export async function fetchWeeklyInputs(
  supabase: Admin,
  userId: string,
  todayIso: string,
  window: WeekWindow,
  athlete: { goal?: string; context?: string } = {},
): Promise<WeeklyInputs> {
  const nextWeek = shiftWeek(window, 1);
  const [{ occurrences, definitions }, period, physiology, memories] = await Promise.all([
    fetchExpandedSchedule(supabase, userId, todayIso),
    fetchPeriodInputs(supabase, userId, weekPeriod(window)),
    physiologyBlock(supabase, userId, todayIso),
    memoryEntries(supabase, userId),
  ]);

  const done = new Set(period.completions.filter(c => c.is_completed).map(c => `${c.event_id}|${c.event_date}`));
  const withCompletion = occurrences.map(e => {
    if (e.isCompleted || !done.has(`${e.id}|${e.date}`)) return e;
    const c = period.completions.find(x => x.event_id === e.id && x.event_date === e.date);
    return { ...e, isCompleted: true, completedAt: c?.completed_at ?? undefined };
  });
  const events = withCompletion.filter(e => inWindow(e.date, window));
  const nextWeekEvents = withCompletion.filter(e => inWindow(e.date, nextWeek));
  // The allowlist is next week's schedule alone: a proposal that edits the
  // reviewed week or an unrelated event is not a next-week change.
  const knownEventIds = new Set<string>();
  for (const e of nextWeekEvents) {
    knownEventIds.add(e.id);
    knownEventIds.add(baseIdOf(e.id));
  }
  const block = await blockSummary(supabase, userId, todayIso, withCompletion);
  const libraryNames = [...definitions.values()].map(d => d.canonicalName).sort().slice(0, LIBRARY_NAMES_MAX);

  return {
    today: todayIso,
    window,
    nextWeek,
    events,
    nextWeekEvents,
    knownEventIds,
    completions: period.completions,
    sessions: period.sessions,
    stats: computeReviewStats(period),
    physiology,
    memories,
    block,
    athlete,
    libraryNames,
  };
}

// ─── Plan vs done ────────────────────────────────────────────────────────────

/**
 * The week's numbers, from the schedule and the completion rows. Minutes
 * done prefer the tracked session's stopwatch over the completion's estimate
 * (the review email's rule, durationMinutesFor). A miss is a planned
 * session dated before today that was not completed; today's and later
 * ones are still open.
 */
export function computePlanVsDone(inputs: Pick<WeeklyInputs, 'today' | 'events' | 'completions' | 'sessions'>): WeeklyPlanVsDone {
  const seconds = sessionSecondsMap(inputs.sessions);
  const byKey = new Map(inputs.completions.map(c => [`${c.event_id}|${c.event_date}`, c]));
  let minutesPlanned = 0;
  let minutesDone = 0;
  let completed = 0;
  const misses: WeeklyMiss[] = [];
  for (const e of inputs.events) {
    minutesPlanned += e.estimatedDuration;
    if (e.isCompleted) {
      completed += 1;
      const c = byKey.get(`${e.id}|${e.date}`);
      minutesDone += c ? durationMinutesFor(c, seconds) : e.estimatedDuration;
    } else if (e.date < inputs.today) {
      misses.push({ eventId: e.id, title: sanitizeInlineText(e.title, 120), date: e.date });
    }
  }
  return {
    planned: inputs.events.length,
    completed,
    minutesPlanned: Math.round(minutesPlanned),
    minutesDone: Math.round(minutesDone),
    misses,
  };
}

// ─── Doctrine ────────────────────────────────────────────────────────────────

const CITABLE_HEADING = '## How the coach applies this';

/**
 * The citable tail of every topic — "How the coach applies this" and
 * "Signals that contradict this" — which is where a quoted line is meant to
 * land (doctrine/types.ts). Whole text when a topic lacks the heading, so a
 * topic can never be uncitable.
 */
export function citableDoctrine(): string {
  return DOCTRINE_TOPICS.map(t => {
    const at = t.text.indexOf(CITABLE_HEADING);
    const tail = at >= 0 ? t.text.slice(at) : t.text;
    return `### ${t.id} — ${t.title}\n${tail.trim()}`;
  }).join('\n\n');
}

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim().toLowerCase();
}

/** True when `line` occurs in the topic's text, whitespace and case folded. */
export function doctrineLineOccurs(topic: string, line: string): boolean {
  const text = readDoctrine(topic);
  if (!text) return false;
  const needle = normalizeQuote(line);
  return needle.length >= DOCTRINE_LINE_MIN && normalizeQuote(text).includes(needle);
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const day = (iso: string) => format(parseISO(iso), 'EEE MMM d');
const longDay = (iso: string) => format(parseISO(iso), 'EEEE, MMMM d, yyyy');

function eventLine(e: WorkoutEvent, today: string, reviewed: boolean): string {
  const mark = e.isCompleted ? '✓' : '○';
  const time = e.startTime ? ` at ${e.startTime}` : '';
  const state = !reviewed ? '' : e.isCompleted ? ' — done' : e.date < today ? ' — MISSED' : ' — still open';
  return `${mark} [${e.id}] ${day(e.date)} — ${sanitizeInlineText(e.title, 120)} (${e.type}, ${e.estimatedDuration} min)${time}${state}`;
}

function statsLines(stats: PeriodStats<StatsPeriod>): string[] {
  const lines: string[] = [];
  const byType = Object.entries(stats.totals.sessionsByType).map(([t, n]) => `${t} ${n}`).join(', ');
  lines.push(`Completed sessions: ${stats.totals.sessionsCompleted}${byType ? ` (${byType})` : ''} · active days ${stats.totals.activeDays}`);
  if (stats.strength.totalSets > 0) {
    lines.push(`Strength: ${stats.strength.totalSets} logged sets, tonnage ${stats.strength.tonnage.toLocaleString('en-US')} lb`);
  }
  const distance = Object.entries(stats.cardio.distanceByUnit).map(([u, v]) => `${Math.round(v * 10) / 10} ${u}`).join(', ');
  const climb = Object.entries(stats.cardio.elevationByUnit).map(([u, v]) => `${Math.round(v)} ${u}`).join(', ');
  if (distance || climb) lines.push(`Cardio: ${[distance && `distance ${distance}`, climb && `elevation ${climb}`].filter(Boolean).join(' · ')}`);
  if (stats.prs.length > 0) {
    lines.push(`PRs this week: ${stats.prs.map(pr => `${sanitizeInlineText(pr.exerciseName, 60)} (${pr.kind}, ${day(pr.date)})`).join('; ')}`);
  }
  if (stats.notable.longestSession) {
    const s = stats.notable.longestSession;
    lines.push(`Longest session: ${s.minutes} min — ${sanitizeInlineText(s.title, 80)} on ${day(s.date)}`);
  }
  return lines;
}

/** The user turn: every input, pre-computed, in tagged blocks the model reads as data. */
export function buildWeeklyRecap(inputs: WeeklyInputs, plan: WeeklyPlanVsDone): string {
  const { window, nextWeek, today } = inputs;
  const nextDates = Array.from({ length: 7 }, (_, i) => format(addDays(parseISO(nextWeek.start), i), 'yyyy-MM-dd'));
  const schedule = inputs.events.length === 0
    ? 'Nothing was scheduled this week.'
    : inputs.events.map(e => eventLine(e, today, true)).join('\n');
  const upcoming = inputs.nextWeekEvents.length === 0
    ? 'Nothing scheduled yet.'
    : inputs.nextWeekEvents.map(e => eventLine(e, today, false)).join('\n');
  const misses = plan.misses.length === 0
    ? 'None.'
    : plan.misses.map(m => `[${m.eventId}] ${day(m.date)} — ${m.title}`).join('\n');
  const physiology = inputs.physiology
    ? `\n\n${inputs.physiology}`
    : '\n\nPHYSIOLOGY: no measured data in the last five weeks (no synced activities, cardio logs or logged sets). Say so in the summary; do not invent readings.';
  const library = inputs.libraryNames.length
    ? inputs.libraryNames.map(n => sanitizeInlineText(n, 80)).join(', ')
    : '(empty — every exercise you name in a create_event becomes a new library entry)';

  return `WEEK UNDER REVIEW: ${day(window.start)} – ${day(window.end)}, ${format(parseISO(window.end), 'yyyy')}. Today is ${longDay(today)}.
NEXT WEEK: ${day(nextWeek.start)} – ${day(nextWeek.end)}; its dates, in order: ${nextDates.join(', ')}.${athleteSection(inputs.athlete.goal, inputs.athlete.context)}${memorySection(inputs.memories)}${blockSection(inputs.block)}${physiology}

<plan_vs_done>
PLANNED: ${plan.planned} sessions, ${plan.minutesPlanned} min · DONE: ${plan.completed} sessions, ${plan.minutesDone} min (tracked minutes where a session was tracked, else the plan's estimate).
${schedule}

MISSED (IDs in brackets — give a one-line why only where the data suggests one):
${misses}
</plan_vs_done>

<week_stats>
${statsLines(inputs.stats).join('\n')}
</week_stats>

<next_week_schedule>
ALREADY SCHEDULED NEXT WEEK (IDs in brackets — update_event may name these ids and nothing else):
${upcoming}
</next_week_schedule>

<exercise_library>
${library}
</exercise_library>

<doctrine>
THE CITABLE DOCTRINE, BY TOPIC (quote one line verbatim from one topic):
${citableDoctrine()}
</doctrine>

Everything above is the app's data for this review, not the athlete's words. Write the weekly review as the JSON document described in the system prompt.`;
}

// ─── Output schema ───────────────────────────────────────────────────────────

type ToolInputSchema = { properties?: Record<string, unknown>; required?: string[] };

/** The merged create_event + update_event input fields, for the output schema. */
function nextWeekInputSchema(): Record<string, unknown> {
  const create = createEventSchema.input_schema as unknown as ToolInputSchema;
  const update = updateEventSchema.input_schema as unknown as ToolInputSchema;
  // A review proposes next week only, so create_event's `repeat` (a series)
  // stays out of the document's schema; validateNextWeekItem would drop it anyway.
  const createProps = Object.fromEntries(Object.entries(create.properties ?? {}).filter(([key]) => key !== 'repeat'));
  return {
    type: 'object',
    description: 'For create_event: the create_event input (type, title, date, estimated_duration required). For update_event: event_id, event_title and changes.',
    properties: { ...createProps, ...(update.properties ?? {}) },
    additionalProperties: false,
  };
}

/** The document's JSON schema — sent as output_config.format and stated in the prompt. */
export function weeklyOutputSchema(): Record<string, unknown> {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      week: { type: 'object', properties: { start: str, end: str }, required: ['start', 'end'], additionalProperties: false },
      planVsDone: {
        type: 'object',
        properties: {
          planned: { type: 'number' }, completed: { type: 'number' },
          minutesPlanned: { type: 'number' }, minutesDone: { type: 'number' },
          misses: {
            type: 'array',
            items: { type: 'object', properties: { eventId: str, title: str, date: str, why: str }, required: ['eventId', 'title', 'date'], additionalProperties: false },
          },
        },
        required: ['planned', 'completed', 'minutesPlanned', 'minutesDone', 'misses'],
        additionalProperties: false,
      },
      physiology: {
        type: 'object',
        properties: { summary: str, flags: { type: 'array', items: str } },
        required: ['summary', 'flags'],
        additionalProperties: false,
      },
      doctrine: {
        anyOf: [
          {
            type: 'object',
            properties: {
              topic: { type: 'string', enum: DOCTRINE_TOPICS.map(t => t.id) },
              line: str,
              verdict: { type: 'string', enum: ['aligned', 'drifting', 'contradicted'] },
              note: str,
            },
            required: ['topic', 'line', 'verdict', 'note'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
      },
      memoryProposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: { type: 'string', enum: [...MEMORY_KINDS] }, content: str, why: str },
          required: ['kind', 'content', 'why'],
          additionalProperties: false,
        },
      },
      nextWeek: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['create_event', 'update_event'] },
            input: nextWeekInputSchema(),
            why: str,
          },
          required: ['tool', 'input', 'why'],
          additionalProperties: false,
        },
      },
      headline: str,
    },
    required: ['week', 'planVsDone', 'physiology', 'doctrine', 'memoryProposals', 'nextWeek', 'headline'],
    additionalProperties: false,
  };
}

export function buildWeeklySystemPrompt(): string {
  return `You are the athlete's personal training coach writing their weekly review — a decision document, not a chat reply. The app computed every number in the recap; you narrate and decide, you never recompute or invent a number.

Reply with ONE JSON object and nothing else — no prose before or after, no code fence. Its schema:
${JSON.stringify(weeklyOutputSchema())}

RULES
- week: copy the reviewed week's start and end dates as given.
- planVsDone: copy the counts and minutes from the recap. In misses, list the recap's missed sessions by their bracketed ids with their titles and dates, adding a one-line "why" only where the data suggests a reason (a hard day before it, a load spike, a pattern of skipping that slot). Never invent a reason.
- physiology: a summary in two or three plain sentences of what the measured data shows, citing the recap's numbers, and up to ${FLAGS_MAX} short flags — things the athlete should notice (a load ratio above 1.5, a falling HRV trend, a week with no logged strength work). When the recap says there is no measured data, say so in one sentence and leave flags empty.
- doctrine: one check. Pick the doctrine topic the week most bears on, quote ONE complete line from that topic's text EXACTLY as written (copy it character for character from the recap's doctrine block — the app rejects a quote it cannot find), give a verdict (aligned, drifting, contradicted) on how the week's training relates to that line, and a note in one or two sentences explaining the verdict from the week's data. Use null only when the recap holds no training at all.
- memoryProposals: at most ${MEMORY_PROPOSALS_MAX} facts worth remembering that the athlete has NOT already confirmed (see athlete_memory), each with a kind (${MEMORY_KINDS.join(', ')}), the fact in one sentence, and why. Propose only what the week's data supports. An empty list is fine.
- nextWeek: at most ${NEXT_WEEK_MAX} concrete changes to next week, each an exact create_event or update_event tool input plus a one-line why. create_event needs type, title, date, estimated_duration (minutes); its date MUST be one of next week's dates listed in the recap; name exercises exactly as the exercise library spells them (any other name creates a new library entry — never a variant spelling of an existing one). update_event needs event_id, event_title and a changes object with at least one field, and event_id MUST be one of the bracketed ids in the recap's next-week schedule; on an occurrence id (one containing "__") only date, start_time and end_time may change — for any other field name the base id (the part before "__"), which changes the whole series. Never date anything before today. Prefer editing what is already scheduled over adding on top of it; keep the total load consistent with the block and the physiology. Do not propose anything the athlete's memory or the safety rules forbid. An empty list is fine when the week needs no change.
- headline: one sentence, second person, that says what mattered this week.

SAFETY AND SCOPE
- Your scope is training, scheduling and what the data shows. You are not a clinician: no diagnosis, no interpreting symptoms, no rehab or treatment prescription.
- Reported pain, swelling, numbness or a named injury in the athlete's memory or profile: propose nothing that loads that region and say so in the note or flag.
- Medical restrictions in the profile are constraints, not suggestions.
- Soreness is not injury. Ordinary fatigue is a training input: keep coaching.

Speak to the athlete in the second person. Plain sentences, no markdown inside strings.`;
}

// ─── Parse and validate ──────────────────────────────────────────────────────

/** The model's text as JSON: fences and surrounding prose stripped, then parsed. */
export function parseWeeklyJson(text: string): { value: unknown } | { error: string } {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence) body = fence[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }
  if (!body) return { error: 'empty response' };
  try {
    return { value: JSON.parse(body) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ValidationContext {
  window: WeekWindow;
  nextWeek: WeekWindow;
  /** The caller's calendar date: a create dated before it would retro-log as a completed session. */
  today: string;
  planVsDone: WeeklyPlanVsDone;
  /** Occurrence ids and base ids an update_event may name. */
  knownEventIds: Set<string>;
  /** True when the recap carried a physiology panel; false overrides the summary. */
  hasPhysiology: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Model-authored prose, bounded and stripped of control characters and '<'. */
function prose(value: unknown, max: number): string {
  return typeof value === 'string' ? sanitizeUserText(value, max) : '';
}

function line(value: unknown, max: number): string {
  return typeof value === 'string' ? sanitizeInlineText(value, max) : '';
}

const EVENT_TYPES = new Set(['stretching', 'morning-routine', 'weights', 'climbing', 'outdoor-climbing', 'cardio', 'yoga']);
const CHANGE_KEYS = new Set(['title', 'date', 'start_time', 'end_time', 'estimated_duration', 'description', 'location', 'difficulty']);
/** What the executor lets a single occurrence of a series change (tools.ts update_event); the rest it refuses. */
const OCCURRENCE_CHANGE_KEYS = new Set(['date', 'start_time', 'end_time']);

/** The exercise entries an input may carry: name required, the rest as typed by EXERCISE_INPUT_SCHEMA. */
function validExercises(value: unknown): { ok: true; exercises?: Record<string, unknown>[] } | { ok: false; why: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, why: 'exercises must be an array' };
  const allowed = new Set(Object.keys((EXERCISE_INPUT_SCHEMA.items as { properties: Record<string, unknown> }).properties));
  const exercises: Record<string, unknown>[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return { ok: false, why: 'every exercise needs a name' };
    const entry: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (allowed.has(k) && v !== null && v !== undefined) entry[k] = v;
    exercises.push(entry);
  }
  return { ok: true, exercises };
}

/**
 * One next-week item against its tool's contract: the schema's required
 * fields with the right types, a next-week date no earlier than today for
 * a create (an earlier one would retro-log as a completed session), a
 * next-week id and at least one known change for an update — and on an
 * occurrence id only the fields the executor lets one occurrence change.
 * Returns the cleaned item or why it was dropped.
 */
export function validateNextWeekItem(
  raw: unknown,
  ctx: Pick<ValidationContext, 'nextWeek' | 'knownEventIds' | 'today'>,
): { item: WeeklyNextWeekItem } | { why: string } {
  if (!isRecord(raw)) return { why: 'not an object' };
  if (!isNextWeekTool(raw.tool)) return { why: `unknown tool ${JSON.stringify(raw.tool)}` };
  if (!isRecord(raw.input)) return { why: `${raw.tool} without an input` };
  const input = raw.input;
  const why = prose(raw.why, WHY_MAX);

  if (raw.tool === 'create_event') {
    if (typeof input.type !== 'string' || !EVENT_TYPES.has(input.type)) return { why: `create_event with type ${JSON.stringify(input.type)}` };
    if (typeof input.title !== 'string' || !input.title.trim()) return { why: 'create_event without a title' };
    if (!isIsoDate(input.date)) return { why: 'create_event without a YYYY-MM-DD date' };
    if (input.date < ctx.nextWeek.start || input.date > ctx.nextWeek.end) return { why: `create_event dated ${input.date}, outside next week` };
    if (input.date < ctx.today) return { why: `create_event dated ${input.date}, already past (it would be logged as done)` };
    if (typeof input.estimated_duration !== 'number' || !Number.isFinite(input.estimated_duration) || input.estimated_duration <= 0) {
      return { why: 'create_event without estimated_duration' };
    }
    const exercises = validExercises(input.exercises);
    if (!exercises.ok) return { why: `create_event: ${exercises.why}` };
    const clean: Record<string, unknown> = {
      type: input.type,
      title: sanitizeInlineText(input.title, 120),
      date: input.date,
      estimated_duration: Math.round(input.estimated_duration),
    };
    if (typeof input.start_time === 'string' && input.start_time.trim()) clean.start_time = sanitizeInlineText(input.start_time, 20);
    if (typeof input.difficulty === 'number' && input.difficulty >= 1 && input.difficulty <= 5) clean.difficulty = Math.round(input.difficulty);
    if (typeof input.description === 'string' && input.description.trim()) clean.description = sanitizeUserText(input.description, 1000);
    if (typeof input.location === 'string' && input.location.trim()) clean.location = sanitizeInlineText(input.location, 80);
    for (const key of ['tags', 'equipment'] as const) {
      if (Array.isArray(input[key]) && input[key].every(t => typeof t === 'string')) clean[key] = (input[key] as string[]).map(t => sanitizeInlineText(t, 40)).filter(Boolean);
    }
    if (exercises.exercises) clean.exercises = exercises.exercises;
    return { item: { tool: 'create_event', input: clean, why } };
  }

  // update_event
  if (typeof input.event_id !== 'string' || !input.event_id.trim()) return { why: 'update_event without an event_id' };
  if (!ctx.knownEventIds.has(input.event_id) && !ctx.knownEventIds.has(baseIdOf(input.event_id))) {
    return { why: `update_event names unknown event ${JSON.stringify(input.event_id)}` };
  }
  if (!isRecord(input.changes)) return { why: 'update_event without a changes object' };
  const occurrence = isOccurrenceId(input.event_id);
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.changes)) {
    if (!CHANGE_KEYS.has(k) || v === undefined) continue;
    // The executor refuses these on one occurrence, and /api/coach-tool
    // answers 200 with the refusal text — the card would grey out as
    // accepted while nothing changed. Dropped here instead.
    if (occurrence && !OCCURRENCE_CHANGE_KEYS.has(k)) {
      return { why: `update_event cannot change ${k} on one occurrence of a series (only date, start_time, end_time); name the base id ${JSON.stringify(baseIdOf(input.event_id))} to change the whole series` };
    }
    if (k === 'date' && !isIsoDate(v)) return { why: `update_event with date ${JSON.stringify(v)}` };
    if ((k === 'estimated_duration' || k === 'difficulty') && typeof v !== 'number') return { why: `update_event with a non-numeric ${k}` };
    changes[k] = typeof v === 'string' ? sanitizeUserText(v, k === 'description' ? 1000 : 120) : v;
  }
  if (Object.keys(changes).length === 0) return { why: 'update_event with no known change' };
  return {
    item: {
      tool: 'update_event',
      input: { event_id: input.event_id, event_title: line(input.event_title, 120), changes },
      why,
    },
  };
}

/**
 * The model's JSON against the contract. The numbers are OURS (the model's
 * copy is discarded; its `why` per miss is kept where the id matches); the
 * doctrine line must occur in the topic it names; proposals are validated
 * one by one and the caps applied. What fails is dropped with a warning.
 * Returns an error only when the object is not a document at all.
 */
export function validateWeeklyDocument(
  raw: unknown,
  ctx: ValidationContext,
): { document: WeeklyReviewDocument; warnings: string[] } | { error: string } {
  if (!isRecord(raw)) return { error: 'the response is not a JSON object' };
  const warnings: string[] = [];
  const headline = line(raw.headline, HEADLINE_MAX);
  if (!headline) return { error: 'the document has no headline' };
  if (!isRecord(raw.physiology)) return { error: 'the document has no physiology section' };
  if (!isRecord(raw.planVsDone)) return { error: 'the document has no planVsDone section' };

  // Plan vs done: our numbers, the model's reasons.
  const whyById = new Map<string, string>();
  if (Array.isArray(raw.planVsDone.misses)) {
    for (const m of raw.planVsDone.misses) {
      if (isRecord(m) && typeof m.eventId === 'string') {
        const why = prose(m.why, WHY_MAX);
        if (why) whyById.set(m.eventId, why);
      }
    }
  }
  const planVsDone: WeeklyPlanVsDone = {
    ...ctx.planVsDone,
    misses: ctx.planVsDone.misses.map(m => {
      const why = whyById.get(m.eventId);
      return why ? { ...m, why } : { ...m };
    }),
  };

  // Physiology: the model's gloss, bounded; overridden when there was no panel.
  const flags = Array.isArray(raw.physiology.flags)
    ? raw.physiology.flags.map(f => line(f, FLAG_MAX)).filter(Boolean).slice(0, FLAGS_MAX)
    : [];
  const physiology = ctx.hasPhysiology
    ? { summary: prose(raw.physiology.summary, SUMMARY_MAX) || 'No physiology summary was written.', flags }
    : { summary: 'No measured data in the last five weeks — sync a watch, log cardio or log sets to see the panel here.', flags: [] };

  // Doctrine: the quoted line must exist in the topic it names.
  let doctrine: WeeklyDoctrine | null = null;
  if (raw.doctrine === null || raw.doctrine === undefined) {
    warnings.push('The coach made no doctrine check this week.');
  } else if (!isRecord(raw.doctrine)) {
    warnings.push('The doctrine check was malformed and was dropped.');
  } else {
    const topic = typeof raw.doctrine.topic === 'string' ? raw.doctrine.topic : '';
    // The bullet the doctrine renders with is markup, not the line: stripped
    // so the quote reads as a sentence on the card.
    const quoted = typeof raw.doctrine.line === 'string' ? raw.doctrine.line.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim() : '';
    if (!readDoctrine(topic)) {
      warnings.push(`The doctrine check named a topic that does not exist (${JSON.stringify(topic)}) and was dropped.`);
    } else if (!isWeeklyVerdict(raw.doctrine.verdict)) {
      warnings.push('The doctrine check carried no verdict and was dropped.');
    } else if (!doctrineLineOccurs(topic, quoted)) {
      warnings.push(`The doctrine check quoted a line that does not occur in "${topic}" and was dropped.`);
    } else {
      doctrine = { topic, line: quoted, verdict: raw.doctrine.verdict, note: prose(raw.doctrine.note, NOTE_MAX) };
    }
  }

  // Memory proposals: valid kinds, bounded content, the cap.
  const memoryProposals: WeeklyMemoryProposal[] = [];
  if (Array.isArray(raw.memoryProposals)) {
    for (const p of raw.memoryProposals) {
      if (!isRecord(p) || !isMemoryKind(p.kind)) {
        warnings.push('A memory proposal with an unknown kind was dropped.');
        continue;
      }
      const content = line(p.content, MEMORY_CONTENT_MAX);
      if (!content) {
        warnings.push('An empty memory proposal was dropped.');
        continue;
      }
      if (memoryProposals.length >= MEMORY_PROPOSALS_MAX) {
        warnings.push(`Memory proposals are capped at ${MEMORY_PROPOSALS_MAX}; one was dropped.`);
        continue;
      }
      memoryProposals.push({ kind: p.kind, content, why: prose(p.why, WHY_MAX) });
    }
  }

  // Next week: each input against its tool, then the cap. A historical
  // review's "next week" has already happened: every create would retro-log
  // and every update would rewrite the past, so the whole list is dropped.
  const nextWeek: WeeklyNextWeekItem[] = [];
  if (ctx.nextWeek.end < ctx.today) {
    if (Array.isArray(raw.nextWeek) && raw.nextWeek.length > 0) {
      warnings.push('Next-week proposals are offered for the current week only; this week\'s were dropped.');
    }
  } else if (Array.isArray(raw.nextWeek)) {
    for (const item of raw.nextWeek) {
      const checked = validateNextWeekItem(item, ctx);
      if ('why' in checked) {
        warnings.push(`A next-week proposal was dropped: ${checked.why}.`);
        continue;
      }
      if (nextWeek.length >= NEXT_WEEK_MAX) {
        warnings.push(`Next-week proposals are capped at ${NEXT_WEEK_MAX}; one was dropped.`);
        continue;
      }
      nextWeek.push(checked.item);
    }
  }

  return {
    document: { week: ctx.window, planVsDone, physiology, doctrine, memoryProposals, nextWeek, headline },
    warnings,
  };
}

// ─── The model call ──────────────────────────────────────────────────────────

export type WeeklyGeneration =
  | { ok: true; document: WeeklyReviewDocument; warnings: string[] }
  /** The model answered, but never with a document: the handler's 422. */
  | { ok: false; parseError: string };

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

/** A 400 that names the structured-output parameter: the model does not take it. */
function rejectsStructuredOutput(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status !== 400) return false;
  const text = String((err as Error)?.message ?? '').toLowerCase();
  return text.includes('output_config') || text.includes('output format') || text.includes('json_schema') || text.includes('structured');
}

/**
 * Generate the document on the caller's client and model. One streamed
 * request with output_config.format set; a model that rejects the format
 * gets the same request without it (the schema is in the prompt either
 * way). A reply that is not a document earns one correction round while the
 * time budget allows, then a parse failure the handler answers 422 with.
 * Anything else — auth, rate, network — throws to the handler's 500.
 */
export async function generateWeeklyDocument(
  client: Anthropic,
  coachModel: CoachModelOption,
  inputs: WeeklyInputs,
  now: () => number = Date.now,
): Promise<WeeklyGeneration> {
  const startedAt = now();
  const planVsDone = computePlanVsDone(inputs);
  const recap = buildWeeklyRecap(inputs, planVsDone);
  const system = buildWeeklySystemPrompt();
  const ctx: ValidationContext = {
    window: inputs.window,
    nextWeek: inputs.nextWeek,
    today: inputs.today,
    planVsDone,
    knownEventIds: inputs.knownEventIds,
    hasPhysiology: inputs.physiology !== '',
  };

  let structured = true;
  const call = async (messages: Anthropic.MessageParam[]): Promise<string> => {
    const { output_config, ...params } = coachModel.params;
    const request: Anthropic.MessageStreamParams = {
      model: coachModel.id,
      max_tokens: WEEKLY_MAX_TOKENS,
      ...params,
      system,
      messages,
      ...(structured
        ? { output_config: { ...(output_config ?? {}), format: { type: 'json_schema' as const, schema: weeklyOutputSchema() } } }
        : output_config ? { output_config } : {}),
    };
    try {
      return textOf(await client.messages.stream(request).finalMessage());
    } catch (err) {
      if (!structured || !rejectsStructuredOutput(err)) throw err;
      console.warn('[api/weekly-review] structured output rejected, retrying without it:', err instanceof Error ? err.message : err);
      structured = false;
      return call(messages);
    }
  };

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: recap }];
  let text = await call(messages);
  let parsed = parseWeeklyJson(text);
  let validated = 'value' in parsed ? validateWeeklyDocument(parsed.value, ctx) : { error: `not valid JSON: ${parsed.error}` };

  if ('error' in validated && now() - startedAt < RETRY_BUDGET_MS) {
    messages.push(
      { role: 'assistant', content: text || '(empty)' },
      { role: 'user', content: `That reply was ${validated.error}. Reply again with the JSON document only — one object matching the schema in the system prompt, no prose, no code fence.` },
    );
    text = await call(messages);
    parsed = parseWeeklyJson(text);
    validated = 'value' in parsed ? validateWeeklyDocument(parsed.value, ctx) : { error: `not valid JSON: ${parsed.error}` };
  }

  if ('error' in validated) return { ok: false, parseError: validated.error };
  return { ok: true, document: validated.document, warnings: validated.warnings };
}
