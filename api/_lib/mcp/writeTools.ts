import type Anthropic from '@anthropic-ai/sdk';
import { ToolInputError, type McpToolAnnotations, type McpToolDef } from './protocol.js';
import { optionalBoolean, optionalEnum, requireDate, requireString } from './args.js';
import { fetchDefinitionRows, todayIso } from './data.js';
import { COACH_TOOLS } from '../../../src/lib/coach/tools.js';
import { buildCoachToolDeps } from '../coach/toolDeps.js';
import { applyMemoryCommand } from '../coach/memory.js';
import { MEMORY_ROOT, memoryPathList } from '../../../src/lib/coach/memory.js';
import {
  applyQuickUncomplete,
  buildFinishSummary,
  loadResolvedOccurrence,
  quickCompletePlan,
} from '../trackerSession.js';
import { recordCompletion } from '../services/completions.js';
import {
  createBlockResource,
  deleteBlockResource,
  updateBlockResource,
  type BlockResource,
} from '../services/blocks.js';
import { buildCompletionRows } from '../../../src/lib/schedule/mapping.js';
import { matchDefinitionByName, rowToDefinition } from '../../../src/lib/schedule/definitions.js';
import { resolvePlannedSets } from '../../../src/lib/tracking/plan.js';
import { BLOCK_PHASES, OBJECTIVE_DISCIPLINES } from '../../../src/types/blocks.js';
import type { Exercise, WorkoutEvent } from '../../../src/types/workout.js';
import type { CardioLogRow, SetLogRow, TablesInsert, TrackedSection } from '../../../src/lib/db/types.js';

// The connector's WRITE surface: what an assistant with a write-scoped
// token may change. Two kinds of tool live here.
//
// Coach-backed tools wrap the in-app coach's own mutation executors
// (src/lib/coach/tools.ts — the ones the evals test) over the same deps the
// confirm-card door uses (api/_lib/coach/toolDeps.ts). Nothing about how a
// workout, exercise, meal, note or contract is written is reimplemented;
// only the schema is re-cut for a client that has no confirmation card and
// no coach prompt (the card-only fields go, `today` arrives).
//
// Native tools cover what the coach never had a tool for: completing or
// logging a workout, blocks and objectives, the profile, coach memory and
// note dismissal — each over the same services the HTTP handlers use.
//
// Every write stamps triggered_by 'ai' (serverDeps / the services), so the
// daily AI-change cap (rateLimit.ts) counts it and Profile → Coach activity
// lists it. The dispatcher refuses all of these for a read-only token and
// checks the cap before each call (handlers/mcp.ts) — nothing here needs to.

type Admin = Parameters<McpToolDef['run']>[0];

const TODAY_PROPERTY = {
  type: 'string',
  description: "The user's local date, YYYY-MM-DD. Defaults to today in UTC. Decides whether a created workout is a plan or a retro-log.",
};

/** Split the optional `today` off a write tool's arguments. */
function takeToday(args: Record<string, unknown>): { today: string; input: Record<string, unknown> } {
  const { today: raw, ...input } = args;
  const today = raw === undefined || raw === null ? todayIso() : requireDate(args, 'today');
  return { today, input };
}

const CLOSED = { openWorldHint: false } as const;

// ─── Coach-backed tools ──────────────────────────────────────────────────────

/** Fields the coach schemas carry only for the confirmation card's label. */
const CARD_ONLY_FIELDS = new Set(['event_title', 'event_date_display', 'meal_title', 'target_label', 'reason']);

/** Coach-prompt phrasing in the schemas, reworded for a client that sees tool results instead of a prompt. */
const PROMPT_PHRASES: Array<[string, string]> = [
  ['The event ID shown in [brackets] in the schedule.', 'The event_id from get_schedule (a recurring occurrence is base-id__YYYY-MM-DD).'],
  ['The meal ID shown in [brackets] in the meals list.', 'The meal id from get_meals.'],
  ['the event id from [brackets] for an event', 'the event_id from get_schedule for an event'],
  ['Exact EXERCISE LIBRARY name (current name, not the new one).', 'The exact library name (resolve it with search_exercises; the current name, not the new one).'],
  ['Check the EXERCISE LIBRARY first — ', 'Check the library with search_exercises first — '],
  ['`name` must exactly match an EXERCISE LIBRARY name to reference it;', '`name` must exactly match an exercise library name (search_exercises) to reference it;'],
];

function reworded(text: string): string {
  for (const [from, to] of PROMPT_PHRASES) text = text.split(from).join(to);
  return text;
}

function mcpSchemaFrom(schema: Anthropic.Tool): Record<string, unknown> {
  const input = JSON.parse(reworded(JSON.stringify(schema.input_schema))) as { properties?: Record<string, unknown>; required?: string[] };
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.properties ?? {})) {
    if (!CARD_ONLY_FIELDS.has(key)) properties[key] = value;
  }
  properties.today = TODAY_PROPERTY;
  const required = (input.required ?? []).filter(key => !CARD_ONLY_FIELDS.has(key));
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function coachBacked(
  name: string,
  opts: { description?: string; annotations: McpToolAnnotations },
): McpToolDef {
  const coach = COACH_TOOLS.find(t => t.schema.name === name);
  if (!coach || !('input_schema' in coach.schema)) throw new Error(`No coach tool schema named ${name}`);
  const schema = coach.schema;
  return {
    name,
    description: opts.description ?? reworded(schema.description ?? ''),
    inputSchema: mcpSchemaFrom(schema),
    access: 'write',
    annotations: { ...CLOSED, readOnlyHint: false, ...opts.annotations },
    async run(supabase, userId, args) {
      const { today, input } = takeToday(args);
      const deps = await buildCoachToolDeps(supabase, userId, today, input);
      // The executor's text states what happened or why it was refused —
      // the same sentence the in-app coach reads back after a confirmed card.
      return { message: await coach.execute(input, deps) };
    },
  };
}

const COACH_BACKED_TOOLS: readonly McpToolDef[] = [
  coachBacked('create_event', { annotations: { title: 'Create workout', destructiveHint: false, idempotentHint: false } }),
  coachBacked('update_event', { annotations: { title: 'Update workout', destructiveHint: false, idempotentHint: true } }),
  coachBacked('delete_event', { annotations: { title: 'Delete workout', destructiveHint: true, idempotentHint: true } }),
  coachBacked('set_event_exercises', { annotations: { title: 'Replace exercise list', destructiveHint: true, idempotentHint: true } }),
  coachBacked('create_exercise_definition', { annotations: { title: 'Add library exercise', destructiveHint: false, idempotentHint: false } }),
  coachBacked('update_exercise_definition', { annotations: { title: 'Edit library exercise', destructiveHint: false, idempotentHint: true } }),
  coachBacked('log_meal', { annotations: { title: 'Log meal', destructiveHint: false, idempotentHint: false } }),
  coachBacked('update_meal', { annotations: { title: 'Update meal', destructiveHint: false, idempotentHint: true } }),
  coachBacked('delete_meal', { annotations: { title: 'Delete meal', destructiveHint: true, idempotentHint: true } }),
  coachBacked('propose_contract_edit', {
    description:
      "Replace the coaching contract — the user's own text on how they want to be coached (read it with " +
      'get_profile). Send the WHOLE new text in `after` and copy the current contract verbatim into `before`; ' +
      'the edit is refused if the contract changed since you read it. Use it only when the user asks to be ' +
      'coached differently, and show them the new text first.',
    annotations: { title: 'Edit coaching contract', destructiveHint: false, idempotentHint: true },
  }),
  coachBacked('leave_note', {
    description:
      'Pin a short note where it refers: on a calendar day, on one workout (its event_id; a recurring ' +
      'occurrence as base-id__YYYY-MM-DD), or on a training block (its id from get_training_blocks). It shows ' +
      'as a chip there in the app until the user dismisses it — a remark tied to a specific day, session or ' +
      'block, not a reply.',
    annotations: { title: 'Leave note', destructiveHint: false, idempotentHint: false },
  }),
];

// ─── Coach memory ────────────────────────────────────────────────────────────

const updateCoachMemoryTool: McpToolDef = {
  name: 'update_coach_memory',
  description:
    "Remember, change or forget facts in the coach's long-term memory about the user — the same facts the " +
    `in-app coach keeps (injuries, preferences, goals, history, notes). Read it first with get_coach_memory. Files: ${memoryPathList()}. ` +
    '`create` or `insert` adds one fact per non-empty line of text; `str_replace` changes one fact (name it by its ' +
    '[id:…] marker or its text; an empty new_str forgets it); `delete` forgets every fact in a file. Only ' +
    'remember what the user stated or clearly implied.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['create', 'insert', 'str_replace', 'delete'] },
      path: { type: 'string', description: `One of the memory files under ${MEMORY_ROOT}.` },
      file_text: { type: 'string', description: 'create: the facts to add, one per line.' },
      insert_text: { type: 'string', description: 'insert: the facts to add, one per line.' },
      old_str: { type: 'string', description: 'str_replace: the fact to change — its [id:…] marker or its text.' },
      new_str: { type: 'string', description: 'str_replace: the replacement; empty forgets the fact.' },
    },
    required: ['command', 'path'],
  },
  access: 'write',
  annotations: { ...CLOSED, title: 'Update coach memory', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async run(supabase, userId, args) {
    const command = optionalEnum(args, 'command', ['create', 'insert', 'str_replace', 'delete'] as const, 'create');
    const path = requireString(args, 'path');
    const message = await applyMemoryCommand(supabase, userId, { ...args, command, path }, { sourceKind: 'chat' });
    return { message };
  },
};

// ─── Completing and logging a workout ────────────────────────────────────────

const OCCURRENCE_PROPERTIES = {
  event_id: { type: 'string', description: 'The event_id from get_schedule (a recurring occurrence is base-id__YYYY-MM-DD).' },
  date: { type: 'string', description: "The occurrence's date, YYYY-MM-DD, as get_schedule lists it." },
};

async function loadOccurrence(supabase: Admin, userId: string, args: Record<string, unknown>): Promise<WorkoutEvent> {
  const eventId = requireString(args, 'event_id');
  const date = requireDate(args, 'date');
  const event = await loadResolvedOccurrence(supabase, userId, eventId, date);
  if (!event) throw new ToolInputError(`No workout with event_id "${eventId}" — ids come from get_schedule.`);
  return event;
}

async function setCompleted(supabase: Admin, userId: string, event: WorkoutEvent, completed: boolean): Promise<void> {
  const rows = buildCompletionRows(event, completed);
  const result = await recordCompletion(
    supabase, userId,
    rows.completionRow as unknown as Record<string, unknown>,
    rows.logRow as unknown as Record<string, unknown>,
  );
  if (!result.ok) throw new Error(result.message);
}

const completeWorkoutTool: McpToolDef = {
  name: 'complete_workout',
  description:
    'Mark a planned workout as done as planned (the calendar\'s "Mark as Complete"): every planned set is ' +
    'logged at its target and flagged autofilled, so records and stats count the session. When the user ' +
    'reports what they actually did, use log_workout instead — it records the real numbers.',
  inputSchema: { type: 'object', properties: { ...OCCURRENCE_PROPERTIES, today: TODAY_PROPERTY }, required: ['event_id', 'date'] },
  access: 'write',
  annotations: { ...CLOSED, title: 'Mark workout complete', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async run(supabase, userId, args) {
    const event = await loadOccurrence(supabase, userId, args);
    await setCompleted(supabase, userId, event, true);
    const quick = await quickCompletePlan(supabase, userId, event);
    if (!quick.ok) throw new Error(quick.message);
    return {
      ok: true,
      event_id: event.id,
      date: event.date,
      title: event.title,
      message: 'Marked complete; the planned sets were logged at their targets (autofilled). Anything logged by hand was kept.',
    };
  },
};

const uncompleteWorkoutTool: McpToolDef = {
  name: 'uncomplete_workout',
  description:
    'Undo a completion: the workout goes back to planned and the autofilled rows from complete_workout are ' +
    'removed. Sets the user logged by hand are kept. Ask before calling it.',
  inputSchema: { type: 'object', properties: { ...OCCURRENCE_PROPERTIES, today: TODAY_PROPERTY }, required: ['event_id', 'date'] },
  access: 'write',
  annotations: { ...CLOSED, title: 'Mark workout not complete', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async run(supabase, userId, args) {
    const event = await loadOccurrence(supabase, userId, args);
    await setCompleted(supabase, userId, event, false);
    const result = await applyQuickUncomplete(supabase, userId, event.id, event.date);
    if (!result.ok) throw new Error(result.message);
    return { ok: true, event_id: event.id, date: event.date, title: event.title, message: 'Marked not complete; autofilled rows removed, hand-logged sets kept.' };
  },
};

const SECTIONS: readonly TrackedSection[] = ['warmup', 'exercise', 'cooldown'];
const MAX_SET_ROWS = 200;
const MAX_CARDIO_ROWS = 50;
const SET_LOG_CONFLICT = 'user_id,event_id,event_date,section,exercise_id,set_number';
const CARDIO_CONFLICT = 'user_id,event_id,event_date,section,exercise_id';

interface PlannedEntry {
  section: TrackedSection;
  exercise: Exercise;
}

function plannedEntries(event: WorkoutEvent): PlannedEntry[] {
  const lists: Array<[TrackedSection, Exercise[] | undefined]> = [
    ['warmup', event.warmup],
    ['exercise', event.exercises],
    ['cooldown', event.cooldown],
  ];
  return lists.flatMap(([section, list]) => (list ?? []).map(exercise => ({ section, exercise })));
}

const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** A free-text string or number as the tracker's free-text actual; null when absent. */
function actualText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function optionalArray(args: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolInputError(`${key} must be an array.`);
  if (value.length > max) throw new ToolInputError(`${key} cannot exceed ${max} entries.`);
  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ToolInputError(`${key}[${i}] must be an object.`);
    return item as Record<string, unknown>;
  });
}

const logWorkoutTool: McpToolDef = {
  name: 'log_workout',
  description:
    'Record what the user actually did in a workout: the sets (weight / reps / duration per set) and cardio ' +
    '(minutes, distance, elevation, heart rate) against the exercises on its plan, then by default mark it ' +
    'complete. Exercise names must match the plan (get_workout_detail shows it; names are alias-aware). Logging ' +
    'the same set number again overwrites it. Only log numbers the user stated. Returns any personal records ' +
    'the session set.',
  inputSchema: {
    type: 'object',
    properties: {
      ...OCCURRENCE_PROPERTIES,
      sets: {
        type: 'array',
        description: 'Strength, skill, stretch or climbing sets as performed, in order. Set numbers count per exercise; omit set_number to number them in the order given.',
        items: {
          type: 'object',
          properties: {
            exercise: { type: 'string', description: 'The exercise name as it appears on the plan.' },
            section: { type: 'string', enum: [...SECTIONS], description: 'Only needed when the same exercise appears in two sections.' },
            set_number: { type: 'integer', minimum: 1 },
            weight: { type: 'string', description: 'As performed, e.g. "185 lb", "BW", "BW+25".' },
            reps: { type: 'string', description: 'e.g. "5", "8 each side".' },
            duration: { type: 'string', description: 'For timed work, e.g. "45s".' },
          },
          required: ['exercise'],
        },
      },
      cardio: {
        type: 'array',
        description: 'Cardio entries as performed.',
        items: {
          type: 'object',
          properties: {
            exercise: { type: 'string', description: 'The cardio exercise name as it appears on the plan.' },
            section: { type: 'string', enum: [...SECTIONS] },
            duration_minutes: { type: 'number' },
            distance: { type: 'string', description: 'With unit, e.g. "5 mi", "8 km".' },
            elevation_gain: { type: 'string', description: 'With unit, e.g. "1200 ft".' },
            avg_heart_rate: { type: 'integer' },
          },
          required: ['exercise'],
        },
      },
      finish: {
        type: 'boolean',
        description: 'Mark the workout complete and close the session (default true). false saves partial logs and leaves it open.',
      },
      unlogged_sets: {
        type: 'string',
        enum: ['as_planned', 'skipped'],
        description: 'When finishing: planned sets that were not logged count as done at their targets (as_planned, default) or as skipped (logged as 0).',
      },
      duration_minutes: { type: 'number', description: 'Total session length when known; defaults to the planned duration when finishing.' },
      today: TODAY_PROPERTY,
    },
    required: ['event_id', 'date'],
  },
  access: 'write',
  annotations: { ...CLOSED, title: 'Log workout', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async run(supabase, userId, args) {
    const [event, definitionRows] = await Promise.all([
      loadOccurrence(supabase, userId, args),
      fetchDefinitionRows(supabase, userId),
    ]);
    const definitions = definitionRows.map(rowToDefinition);
    const setsIn = optionalArray(args, 'sets', MAX_SET_ROWS);
    const cardioIn = optionalArray(args, 'cardio', MAX_CARDIO_ROWS);
    const finish = optionalBoolean(args, 'finish', true);
    const unlogged = optionalEnum(args, 'unlogged_sets', ['as_planned', 'skipped'] as const, 'as_planned');
    if (!setsIn.length && !cardioIn.length && !finish) {
      throw new ToolInputError('Nothing to log: give sets and/or cardio, or finish: true to mark the workout complete.');
    }
    const durationMinutes = args.duration_minutes;
    if (durationMinutes !== undefined && durationMinutes !== null
      && (typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 7 * 24 * 60)) {
      throw new ToolInputError('duration_minutes must be a non-negative number of minutes.');
    }

    const plan = plannedEntries(event);
    const resolve = (raw: unknown, sectionHint: unknown, kind: 'set' | 'cardio', index: number): PlannedEntry => {
      if (typeof raw !== 'string' || !raw.trim()) throw new ToolInputError(`${kind === 'set' ? 'sets' : 'cardio'}[${index}].exercise is required.`);
      const section = sectionHint === undefined || sectionHint === null
        ? undefined
        : optionalEnum({ section: sectionHint }, 'section', SECTIONS, 'exercise');
      const wanted = normalizeName(raw);
      const def = matchDefinitionByName(raw, definitions);
      const candidates = plan.filter(entry => !section || entry.section === section);
      const found = candidates.find(({ exercise }) =>
        normalizeName(exercise.name) === wanted
        || (def !== undefined && (exercise.definitionId === def.id || normalizeName(exercise.name) === normalizeName(def.canonicalName))));
      if (!found) {
        const names = candidates.map(c => c.exercise.name).join(', ') || '(none)';
        throw new ToolInputError(
          `"${raw}" is not on this workout's plan${section ? ` (${section})` : ''}. Planned: ${names}. ` +
          'Add it with set_event_exercises first, or check the name with search_exercises.',
        );
      }
      const isCardio = found.exercise.category === 'cardio';
      if (kind === 'set' && isCardio) throw new ToolInputError(`"${found.exercise.name}" is cardio — log it under cardio, not sets.`);
      if (kind === 'cardio' && !isCardio) throw new ToolInputError(`"${found.exercise.name}" is not cardio — log it under sets.`);
      return found;
    };

    const now = new Date().toISOString();
    const counters = new Map<string, number>();
    const setRows: SetLogRow[] = setsIn.map((s, i) => {
      const { section, exercise } = resolve(s.exercise, s.section, 'set', i);
      const key = `${section}|${exercise.id}`;
      const given = s.set_number;
      let setNumber: number;
      if (given === undefined || given === null) {
        setNumber = (counters.get(key) ?? 0) + 1;
      } else if (typeof given !== 'number' || !Number.isInteger(given) || given < 1 || given > MAX_SET_ROWS) {
        throw new ToolInputError(`sets[${i}].set_number must be a positive integer.`);
      } else {
        setNumber = given;
      }
      counters.set(key, Math.max(counters.get(key) ?? 0, setNumber));
      const weight = actualText(s.weight);
      const reps = actualText(s.reps);
      const duration = actualText(s.duration);
      if (weight === null && reps === null && duration === null) {
        throw new ToolInputError(`sets[${i}] needs at least one of weight, reps or duration.`);
      }
      const planned = resolvePlannedSets(exercise)[setNumber - 1];
      return {
        event_id: event.id,
        event_date: event.date,
        section,
        exercise_id: exercise.id,
        exercise_name: exercise.name,
        definition_id: exercise.definitionId ?? null,
        set_number: setNumber,
        planned_weight: planned?.targetWeight ?? null,
        planned_reps: planned?.targetReps ?? null,
        planned_duration: planned?.targetDuration ?? null,
        actual_weight: weight,
        actual_reps: reps,
        actual_duration: duration,
        is_autofilled: false,
      };
    });
    const cardioRows: CardioLogRow[] = cardioIn.map((c, i) => {
      const { section, exercise } = resolve(c.exercise, c.section, 'cardio', i);
      const minutes = c.duration_minutes;
      if (minutes !== undefined && minutes !== null && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0)) {
        throw new ToolInputError(`cardio[${i}].duration_minutes must be a non-negative number.`);
      }
      const hr = c.avg_heart_rate;
      if (hr !== undefined && hr !== null && (typeof hr !== 'number' || !Number.isInteger(hr) || hr < 20 || hr > 250)) {
        throw new ToolInputError(`cardio[${i}].avg_heart_rate must be an integer heart rate.`);
      }
      return {
        event_id: event.id,
        event_date: event.date,
        section,
        exercise_id: exercise.id,
        exercise_name: exercise.name,
        definition_id: exercise.definitionId ?? null,
        duration_minutes: typeof minutes === 'number' ? minutes : null,
        distance: actualText(c.distance),
        elevation_gain: actualText(c.elevation_gain),
        avg_heart_rate: typeof hr === 'number' ? hr : null,
        is_autofilled: false,
      };
    });

    // The session row first, so the logs always belong to a started session.
    const { error: sessionErr } = await supabase
      .from('workout_sessions')
      .upsert(
        { user_id: userId, event_id: event.id, event_date: event.date, started_at: now },
        { onConflict: 'user_id,event_id,event_date', ignoreDuplicates: true },
      );
    if (sessionErr) throw new Error(`session upsert failed: ${sessionErr.message}`);

    // Hand-entered rows overwrite what the same set number held (the
    // tracker's save), and never carry the autofilled flag.
    const writes: PromiseLike<{ error: { message: string } | null }>[] = [];
    if (setRows.length) {
      writes.push(supabase
        .from('workout_set_logs')
        .upsert(setRows.map(r => ({ ...r, user_id: userId, updated_at: now })) as TablesInsert<'workout_set_logs'>[], { onConflict: SET_LOG_CONFLICT }));
    }
    if (cardioRows.length) {
      writes.push(supabase
        .from('workout_cardio_logs')
        .upsert(cardioRows.map(r => ({ ...r, user_id: userId, updated_at: now })) as TablesInsert<'workout_cardio_logs'>[], { onConflict: CARDIO_CONFLICT }));
    }
    const failed = (await Promise.all(writes)).find(r => r.error);
    if (failed?.error) throw new Error(`log upsert failed: ${failed.error.message}`);

    const result: Record<string, unknown> = {
      ok: true,
      event_id: event.id,
      date: event.date,
      title: event.title,
      logged_sets: setRows.length,
      logged_cardio: cardioRows.length,
      finished: finish,
    };
    if (!finish) {
      result.message = 'Logs saved; the workout is still open. Call again with finish: true to complete it.';
      return result;
    }

    // Finish: planned work that was not logged lands either at its targets
    // (the calendar's quick-complete, ignoreDuplicates keeps every row above)
    // or as zero-filled skipped sets (the tracker's Finish).
    if (unlogged === 'as_planned') {
      const quick = await quickCompletePlan(supabase, userId, event);
      if (!quick.ok) throw new Error(quick.message);
    } else {
      const zeroRows: SetLogRow[] = [];
      for (const { section, exercise } of plan) {
        if (exercise.category === 'cardio') continue;
        for (const planned of resolvePlannedSets(exercise)) {
          zeroRows.push({
            event_id: event.id, event_date: event.date, section,
            exercise_id: exercise.id, exercise_name: exercise.name, definition_id: exercise.definitionId ?? null,
            set_number: planned.setNumber,
            planned_weight: planned.targetWeight ?? null, planned_reps: planned.targetReps ?? null, planned_duration: planned.targetDuration ?? null,
            actual_weight: planned.targetWeight ? '0' : null,
            actual_reps: planned.targetReps || !planned.targetDuration ? '0' : null,
            actual_duration: planned.targetDuration ? '0' : null,
            is_autofilled: true,
          });
        }
      }
      if (zeroRows.length) {
        const { error } = await supabase
          .from('workout_set_logs')
          .upsert(zeroRows.map(r => ({ ...r, user_id: userId, updated_at: now })) as TablesInsert<'workout_set_logs'>[], { onConflict: SET_LOG_CONFLICT, ignoreDuplicates: true });
        if (error) throw new Error(`zero-fill failed: ${error.message}`);
      }
    }
    const totalSeconds = typeof durationMinutes === 'number'
      ? Math.round(durationMinutes * 60)
      : event.estimatedDuration > 0 ? event.estimatedDuration * 60 : null;
    const { error: finishErr } = await supabase
      .from('workout_sessions')
      .update({ finished_at: now, total_duration_seconds: totalSeconds, updated_at: now })
      .eq('user_id', userId).eq('event_id', event.id).eq('event_date', event.date);
    if (finishErr) throw new Error(`finish failed: ${finishErr.message}`);
    await setCompleted(supabase, userId, event, true);

    // PRs and the recap, from the rows just saved against full history. The
    // session IS finished; a failed summary must not read as a failed finish.
    try {
      const summary = await buildFinishSummary(supabase, userId, event, totalSeconds, null);
      result.prs = summary.prs.map(pr => pr.description);
      result.recap = summary.recap;
    } catch (err) {
      console.warn('[mcp] log_workout summary failed:', err instanceof Error ? err.message : err);
    }
    result.message = `Logged and marked complete${(result.prs as string[] | undefined)?.length ? ` — ${(result.prs as string[]).length} personal record(s)` : ''}.`;
    return result;
  },
};

// ─── Training blocks and objectives ──────────────────────────────────────────

const WEEKLY_TARGETS_SCHEMA = {
  type: 'object',
  description: 'Per-week targets the block is judged against (get_training_blocks reports attainment). Omit a key to leave it unset.',
  properties: {
    cardioMinutes: { type: 'number', description: 'Minutes of cardio-type sessions per week.' },
    strengthSessions: { type: 'number', description: 'Completed weights sessions per week.' },
    climbingSessions: { type: 'number', description: 'Completed climbing sessions per week.' },
    longSessionMinutes: { type: 'number', description: 'A session at or above this many minutes counts as the long day.' },
    vert: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['ft', 'm'] } }, required: ['value', 'unit'] },
    distance: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['mi', 'km'] } }, required: ['value', 'unit'] },
  },
};

const BLOCK_FIELD_PROPERTIES = {
  name: { type: 'string' },
  intent: { type: 'string', description: 'What the block is for, free text.' },
  phase: { type: 'string', enum: [...BLOCK_PHASES] },
  start_date: { type: 'string', description: 'A Monday, YYYY-MM-DD.' },
  end_date_exclusive: { type: 'string', description: 'The Monday the block ends on (exclusive), YYYY-MM-DD. Blocks may not overlap.' },
  objective_id: { type: 'string', description: 'The objective this block serves (get_training_blocks with include_objectives lists ids), or null.' },
  weekly_targets: WEEKLY_TARGETS_SCHEMA,
};

const OBJECTIVE_FIELD_PROPERTIES = {
  name: { type: 'string' },
  target_date: { type: 'string', description: 'YYYY-MM-DD, or null for an undated aspiration.' },
  discipline: { type: 'string', enum: [...OBJECTIVE_DISCIPLINES] },
  notes: { type: 'string' },
  status: { type: 'string', enum: ['active', 'achieved', 'abandoned'] },
};

/** The sanitized failure of a block/objective service call as a tool error, or the value. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; status: number; message: string }): T {
  if (result.ok) return result.value;
  if (result.status >= 500) throw new Error(result.message);
  throw new ToolInputError(result.message);
}

function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new ToolInputError(`${key} must be a non-empty object.`);
  }
  return value as Record<string, unknown>;
}

function blockTools(resource: BlockResource): McpToolDef[] {
  const noun = resource === 'block' ? 'training block' : 'objective';
  const idKey = resource === 'block' ? 'block_id' : 'objective_id';
  const fields = resource === 'block' ? BLOCK_FIELD_PROPERTIES : OBJECTIVE_FIELD_PROPERTIES;
  const idProperty = { type: 'string', description: `The ${noun}'s id from get_training_blocks${resource === 'objective' ? ' (include_objectives: true)' : ''}.` };
  const requiredOnCreate = resource === 'block' ? ['name', 'start_date', 'end_date_exclusive'] : ['name'];
  const Title = noun.replace(/^\w/, c => c.toUpperCase());

  return [
    {
      name: `create_${resource === 'block' ? 'training_block' : 'objective'}`,
      description: resource === 'block'
        ? 'Create a training block: a Monday-to-Monday span with an intent, a phase and weekly targets, optionally serving an objective. Blocks may not overlap.'
        : 'Create an objective — the thing the training is for (a route, a race, a peak, general fitness) — that training blocks can serve.',
      inputSchema: { type: 'object', properties: { ...fields, today: TODAY_PROPERTY }, required: requiredOnCreate },
      access: 'write',
      annotations: { ...CLOSED, title: `Create ${noun}`, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      async run(supabase, userId, args) {
        const { input } = takeToday(args);
        const { id } = unwrap(await createBlockResource(supabase, userId, resource, input, 'ai'));
        return { ok: true, id, message: `${Title} "${String(input.name)}" created [${id}].` };
      },
    },
    {
      name: `update_${resource === 'block' ? 'training_block' : 'objective'}`,
      description: `Change fields on an existing ${noun}. Only include fields that should change; set a field to null to clear it.`,
      inputSchema: {
        type: 'object',
        properties: { [idKey]: idProperty, changes: { type: 'object', properties: fields }, today: TODAY_PROPERTY },
        required: [idKey, 'changes'],
      },
      access: 'write',
      annotations: { ...CLOSED, title: `Update ${noun}`, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run(supabase, userId, args) {
        const id = requireString(args, idKey);
        const changes = requireObject(args, 'changes');
        unwrap(await updateBlockResource(supabase, userId, resource, id, changes, {
          resource_name: typeof changes.name === 'string' ? changes.name : id,
          diff: { after: changes } as never,
          triggered_by: 'ai',
        }));
        return { ok: true, id, message: `${Title} updated.` };
      },
    },
    {
      name: `delete_${resource === 'block' ? 'training_block' : 'objective'}`,
      description: `Delete a ${noun}${resource === 'objective' ? ' (blocks that served it lose the link)' : ''}. Ask before calling it.`,
      inputSchema: { type: 'object', properties: { [idKey]: idProperty, today: TODAY_PROPERTY }, required: [idKey] },
      access: 'write',
      annotations: { ...CLOSED, title: `Delete ${noun}`, readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      async run(supabase, userId, args) {
        const id = requireString(args, idKey);
        unwrap(await deleteBlockResource(supabase, userId, resource, id, { resource_name: id, triggered_by: 'ai' }));
        return { ok: true, id, message: `${Title} deleted.` };
      },
    },
  ];
}

// ─── Profile ─────────────────────────────────────────────────────────────────

const updateProfileTool: McpToolDef = {
  name: 'update_profile',
  description:
    "Change the user's profile basics: display name, the coach's goal line and context paragraph, and the " +
    'heart-rate settings (max and threshold) used for zones. Only include fields that should change; the ' +
    'heart-rate fields accept null to clear them. The coaching contract is edited with propose_contract_edit.',
  inputSchema: {
    type: 'object',
    properties: {
      display_name: { type: 'string', description: 'At most 80 characters.' },
      coach_goal: { type: 'string', description: 'One line on what the user is training for; at most 200 characters, "" clears it.' },
      coach_context: { type: 'string', description: 'Background the coach should know; at most 1000 characters, "" clears it.' },
      max_hr: { type: ['integer', 'null'], description: '100–250, or null.' },
      threshold_hr: { type: ['integer', 'null'], description: '80–230, or null.' },
      today: TODAY_PROPERTY,
    },
  },
  access: 'write',
  annotations: { ...CLOSED, title: 'Update profile', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async run(supabase, userId, args) {
    const fields: Record<string, string | number | null> = {};
    if (args.display_name !== undefined) {
      const name = typeof args.display_name === 'string' ? args.display_name.trim() : '';
      if (!name || name.length > 80) throw new ToolInputError('display_name must be 1–80 characters.');
      fields.display_name = name;
    }
    if (args.coach_goal !== undefined) {
      if (typeof args.coach_goal !== 'string' || args.coach_goal.length > 200) throw new ToolInputError('coach_goal must be a string of at most 200 characters.');
      fields.coach_goal = args.coach_goal.trim();
    }
    if (args.coach_context !== undefined) {
      if (typeof args.coach_context !== 'string' || args.coach_context.length > 1000) throw new ToolInputError('coach_context must be a string of at most 1000 characters.');
      fields.coach_context = args.coach_context.trim();
    }
    const hr = (key: 'max_hr' | 'threshold_hr', min: number, max: number) => {
      const value = args[key];
      if (value === undefined) return;
      if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) {
        throw new ToolInputError(`${key} must be an integer between ${min} and ${max}, or null.`);
      }
      fields[key] = value as number | null;
    };
    hr('max_hr', 100, 250);
    hr('threshold_hr', 80, 230);
    if (Object.keys(fields).length === 0) throw new ToolInputError('No updatable fields given.');

    const { error } = await supabase
      .from('profiles')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw new Error(`profile update failed: ${error.message}`);
    return { ok: true, updated: Object.keys(fields), message: 'Profile updated.' };
  },
};

// ─── Notes ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dismissNoteTool: McpToolDef = {
  name: 'dismiss_note',
  description: 'Dismiss a coach note (from get_notes) so it no longer shows on the calendar. The note is kept, not deleted.',
  inputSchema: {
    type: 'object',
    properties: { note_id: { type: 'string', description: 'The note id from get_notes.' }, today: TODAY_PROPERTY },
    required: ['note_id'],
  },
  access: 'write',
  annotations: { ...CLOSED, title: 'Dismiss note', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async run(supabase, userId, args) {
    const id = requireString(args, 'note_id');
    if (!UUID_RE.test(id)) throw new ToolInputError('note_id must be a note id from get_notes.');
    const { data, error } = await supabase
      .from('coach_annotations')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .is('dismissed_at', null)
      .select('id');
    if (error) throw new Error(`dismiss failed: ${error.message}`);
    const dismissed = (data ?? []).length > 0;
    return { ok: true, dismissed, message: dismissed ? 'Note dismissed.' : 'No live note with that id (already dismissed, or not yours).' };
  },
};

export const MCP_WRITE_TOOLS: readonly McpToolDef[] = [
  ...COACH_BACKED_TOOLS,
  completeWorkoutTool,
  uncompleteWorkoutTool,
  logWorkoutTool,
  ...blockTools('block'),
  ...blockTools('objective'),
  updateProfileTool,
  updateCoachMemoryTool,
  dismissNoteTool,
];
