import { format, isValid, parseISO } from 'date-fns';
import { baseIdOf, isOccurrenceId } from '../schedule/occurrence.js';
import { entryFromDefinition, matchDefinitionByName } from '../schedule/definitions.js';
import { sanitizeInlineText } from './prompt.js';
import { derivedCalories, mealCalories } from '../nutrition/mapping.js';
import type { CoachToolContext } from './tools.js';
import type { Exercise, ExerciseDefinition, WorkoutEvent } from '../../types/workout.js';
import type { Meal } from '../../types/nutrition.js';

// What a confirmed tool call will actually change, computed from the typed
// tool input and the live app state — the structured counterpart to the
// one-line displayLabel in tools.ts. The card shows the label and, under it,
// this preview: "Date  Thu Jul 9 → Fri Jul 10", the exercise list a workout
// will hold, the macros a meal will log. Pure and total: every branch reads
// defensively and previewForTool returns null rather than throwing, so a
// malformed tool call degrades to today's label-only card.
//
// Targets resolve the way the executors resolve them (an id the model
// supplies is matched against real rows, never trusted for its title), and
// a target that resolves to nothing yields null: the label already says
// "(no matching entry for id …)", and a diff against nothing would only
// dress up a call the executor is going to refuse.

export type ToolPreview =
  | { kind: 'event-create'; title: string; date: string; time?: string; durationMinutes?: number; type?: string; exercises: string[] }
  | { kind: 'event-update'; title: string; changes: Array<{ field: string; before: string; after: string }> }
  | { kind: 'event-delete'; title: string; date: string; scope: 'one' | 'series' | 'unknown' }
  | { kind: 'exercises'; title: string; before: string[]; after: string[] }
  | { kind: 'definition-update'; name: string; changes: Array<{ field: string; before: string; after: string }> }
  | { kind: 'meal'; action: 'log' | 'update' | 'delete'; title: string; lines: string[] };

export type PreviewChange = { field: string; before: string; after: string };

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Model-authored free text is bounded and stripped before it reaches the card. */
const TEXT_MAX = 60;

/** The visible stand-in for a field that is unset on one side of a diff. */
export const EMPTY = '—';

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const shown = sanitizeInlineText(raw, TEXT_MAX);
  return shown + (raw.length > TEXT_MAX ? '…' : '');
}

/** "2026-07-09" → "Thu Jul 9"; anything unparseable is shown as given. */
export function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return EMPTY;
  const d = parseISO(value);
  return isValid(d) ? format(d, 'EEE MMM d') : text(value);
}

/** 45 → "45 min". */
export function formatDuration(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} min` : text(value);
}

function formatList(value: unknown): string {
  if (Array.isArray(value)) return value.length ? text(value.join(', ')) : EMPTY;
  return text(value);
}

function formatBool(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : text(value);
}

/** One exercise as it will sit in the workout: "Pistol Squat · 3 × 5 each leg · 25lb". */
export function exerciseLine(e: Pick<Exercise, 'name' | 'sets' | 'reps' | 'duration' | 'weight'>): string {
  const count = e.reps ?? e.duration;
  const parts = [text(e.name)];
  if (typeof e.sets === 'number' && count) parts.push(`${e.sets} × ${sanitizeInlineText(count, TEXT_MAX)}`);
  else if (typeof e.sets === 'number') parts.push(`${e.sets} sets`);
  else if (count) parts.push(sanitizeInlineText(count, TEXT_MAX));
  if (e.weight) parts.push(sanitizeInlineText(e.weight, TEXT_MAX));
  return parts.join(' · ');
}

// ─── Input resolution ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Same rule as tools.ts resolveEvent: exact id, then a base id's occurrences (on `date` when given), then an occurrence id's base row. */
function resolveEvent(ctx: CoachToolContext, id: unknown, date?: unknown): WorkoutEvent | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  const exact = ctx.events.find(e => e.id === id);
  if (exact) return exact;
  const occurrences = ctx.events.filter(e => baseIdOf(e.id) === id);
  if (occurrences.length) {
    return (typeof date === 'string' && occurrences.find(e => e.date === date)) || occurrences[0];
  }
  return ctx.events.find(e => e.id === baseIdOf(id));
}

function resolveMeal(ctx: CoachToolContext, id: unknown): Meal | undefined {
  return typeof id === 'string' ? ctx.meals.find(m => m.id === id) : undefined;
}

/**
 * The exercise lines a tool input will produce, resolved the way the
 * executor resolves them: a library match takes the entry's defaults for any
 * prescription the input leaves out; an unmatched name will be created and
 * is marked as such.
 */
function inputExerciseLines(value: unknown, definitions: Map<string, ExerciseDefinition>): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    const input = raw as { name: string; sets?: unknown; reps?: unknown; duration?: unknown; weight?: unknown };
    const overrides = {
      sets: typeof input.sets === 'number' ? input.sets : undefined,
      reps: typeof input.reps === 'string' ? input.reps : undefined,
      duration: typeof input.duration === 'string' ? input.duration : undefined,
      weight: typeof input.weight === 'string' ? input.weight : undefined,
    };
    const def = matchDefinitionByName(input.name, definitions.values());
    if (def) {
      lines.push(exerciseLine(entryFromDefinition(def, def.id, overrides)));
    } else {
      lines.push(exerciseLine({ name: `${input.name} (new)`, ...overrides }));
    }
  }
  return lines;
}

// ─── Per-tool previews ───────────────────────────────────────────────────────

function createEvent(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  if (typeof input.title !== 'string' || typeof input.date !== 'string') return null;
  return {
    kind: 'event-create',
    title: text(input.title),
    date: formatDate(input.date),
    time: typeof input.start_time === 'string' && input.start_time ? text(input.start_time) : undefined,
    durationMinutes: typeof input.estimated_duration === 'number' ? input.estimated_duration : undefined,
    type: typeof input.type === 'string' ? input.type : undefined,
    exercises: inputExerciseLines(input.exercises, ctx.definitions),
  };
}

// update_event's change keys → the live field and how both sides display.
const EVENT_FIELDS: Record<string, { label: string; key: keyof WorkoutEvent; show: (v: unknown) => string }> = {
  title:              { label: 'Title',       key: 'title',             show: text },
  date:               { label: 'Date',        key: 'date',              show: formatDate },
  start_time:         { label: 'Start',       key: 'startTime',         show: text },
  end_time:           { label: 'End',         key: 'endTime',           show: text },
  estimated_duration: { label: 'Duration',    key: 'estimatedDuration', show: formatDuration },
  description:        { label: 'Description', key: 'description',       show: text },
  location:           { label: 'Location',    key: 'location',          show: text },
  difficulty:         { label: 'Difficulty',  key: 'difficulty',        show: text },
};

function updateEvent(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  const event = resolveEvent(ctx, input.event_id);
  if (!event || !isRecord(input.changes)) return null;
  const changes: PreviewChange[] = [];
  for (const [key, after] of Object.entries(input.changes)) {
    const field = EVENT_FIELDS[key];
    if (!field) continue;
    changes.push({ field: field.label, before: field.show(event[field.key]), after: field.show(after) });
  }
  return changes.length ? { kind: 'event-update', title: text(event.title), changes } : null;
}

/** Same rule as tools.ts resolveOccurrence: with a date, the row on that date by id or base id; without, the exact id. */
function resolveOccurrence(ctx: CoachToolContext, id: unknown, date: unknown): WorkoutEvent | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof date === 'string' && date) {
    return ctx.events.find(e => (e.id === id || baseIdOf(e.id) === id) && e.date === date);
  }
  return ctx.events.find(e => e.id === id);
}

/** One "Completed  no → yes" row: the live flag against the requested one. */
function setEventCompletion(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  const event = resolveOccurrence(ctx, input.event_id, input.date);
  if (!event || typeof input.completed !== 'boolean') return null;
  return {
    kind: 'event-update',
    title: text(event.title),
    changes: [{ field: 'Completed', before: formatBool(!!event.isCompleted), after: formatBool(input.completed) }],
  };
}

function deleteEvent(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  const event = resolveEvent(ctx, input.event_id, input.date);
  if (!event) return null;
  const recurring = event.isRecurring || (typeof input.event_id === 'string' && isOccurrenceId(input.event_id));
  const scope = input.scope === 'instance' ? 'one'
    : input.scope === 'all' ? (recurring ? 'series' : 'one')
    : 'unknown';
  const date = scope === 'one' && typeof input.date === 'string' ? input.date : event.date;
  return { kind: 'event-delete', title: text(event.title), date: formatDate(date), scope };
}

function setEventExercises(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  const event = resolveEvent(ctx, input.event_id);
  if (!event || !Array.isArray(input.exercises)) return null;
  const section = input.section === 'warmup' || input.section === 'cooldown' ? input.section : 'exercises';
  const current = event[section] ?? [];
  return {
    kind: 'exercises',
    title: section === 'exercises' ? text(event.title) : `${text(event.title)} · ${section}`,
    before: current.map(exerciseLine),
    after: inputExerciseLines(input.exercises, ctx.definitions),
  };
}

// update_exercise_definition's change keys → the library field and its display.
const DEFINITION_FIELDS: Record<string, { label: string; key: keyof ExerciseDefinition; show: (v: unknown) => string }> = {
  canonical_name:   { label: 'Name',             key: 'canonicalName',   show: text },
  category:         { label: 'Category',         key: 'category',        show: text },
  muscle_groups:    { label: 'Muscle groups',    key: 'muscleGroups',    show: formatList },
  equipment:        { label: 'Equipment',        key: 'equipment',       show: formatList },
  technique_notes:  { label: 'Technique notes',  key: 'techniqueNotes',  show: text },
  is_unilateral:    { label: 'Unilateral',       key: 'isUnilateral',    show: formatBool },
  default_sets:     { label: 'Default sets',     key: 'defaultSets',     show: text },
  default_reps:     { label: 'Default reps',     key: 'defaultReps',     show: text },
  default_duration: { label: 'Default duration', key: 'defaultDuration', show: text },
  default_weight:   { label: 'Default weight',   key: 'defaultWeight',   show: text },
  default_rest:     { label: 'Default rest',     key: 'defaultRest',     show: text },
};

function updateDefinition(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  if (typeof input.name !== 'string' || !isRecord(input.changes)) return null;
  const def = matchDefinitionByName(input.name, ctx.definitions.values());
  if (!def) return null;
  const changes: PreviewChange[] = [];
  for (const [key, after] of Object.entries(input.changes)) {
    const field = DEFINITION_FIELDS[key];
    if (!field) continue;
    changes.push({ field: field.label, before: field.show(def[field.key]), after: field.show(after) });
  }
  return changes.length ? { kind: 'definition-update', name: text(def.canonicalName), changes } : null;
}

// ─── Meals ───────────────────────────────────────────────────────────────────

// log_meal / update_meal keys → the Meal field and its display, in the order
// the card lists them.
const MEAL_FIELDS: Array<{ key: string; label: string; field: keyof Meal; show: (v: unknown) => string }> = [
  { key: 'title',           label: 'Title',         field: 'title',         show: text },
  { key: 'date',            label: 'Date',          field: 'date',          show: formatDate },
  { key: 'time',            label: 'Time',          field: 'time',          show: text },
  { key: 'meal_type',       label: 'Type',          field: 'mealType',      show: text },
  { key: 'calories',        label: 'Calories',      field: 'calories',      show: grams('kcal') },
  { key: 'protein_g',       label: 'Protein',       field: 'proteinG',      show: grams('g') },
  { key: 'carbs_g',         label: 'Carbs',         field: 'carbsG',        show: grams('g') },
  { key: 'fiber_g',         label: 'Fiber',         field: 'fiberG',        show: grams('g') },
  { key: 'sugar_g',         label: 'Sugar',         field: 'sugarG',        show: grams('g') },
  { key: 'fat_total_g',     label: 'Fat',           field: 'fatTotalG',     show: grams('g') },
  { key: 'fat_saturated_g', label: 'Saturated fat', field: 'fatSaturatedG', show: grams('g') },
  { key: 'fat_trans_g',     label: 'Trans fat',     field: 'fatTransG',     show: grams('g') },
  { key: 'alcohol_g',       label: 'Alcohol',       field: 'alcoholG',      show: grams('g') },
  { key: 'notes',           label: 'Notes',         field: 'notes',         show: text },
];

function grams(unit: string): (v: unknown) => string {
  return v => (typeof v === 'number' && Number.isFinite(v) ? `${v} ${unit}` : text(v));
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** "P 40 g · C 50 g · F 25 g" for whichever macros are set. */
function macroLine(m: Pick<Meal, 'proteinG' | 'carbsG' | 'fatTotalG'>): string | null {
  const parts = [
    m.proteinG !== undefined ? `P ${m.proteinG} g` : null,
    m.carbsG !== undefined ? `C ${m.carbsG} g` : null,
    m.fatTotalG !== undefined ? `F ${m.fatTotalG} g` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : null;
}

function logMeal(input: Record<string, unknown>): ToolPreview | null {
  if (typeof input.title !== 'string' || typeof input.date !== 'string') return null;
  const macros = {
    proteinG: num(input.protein_g), carbsG: num(input.carbs_g),
    fatTotalG: num(input.fat_total_g), alcoholG: num(input.alcohol_g),
  };
  const lines: string[] = [];
  const when = [formatDate(input.date), typeof input.time === 'string' && input.time ? text(input.time) : null]
    .filter(Boolean).join(' · ');
  lines.push(typeof input.meal_type === 'string' && input.meal_type ? `${when} · ${text(input.meal_type)}` : when);
  // The calories the meal will display: the given figure, else the 4/4/9/7
  // derivation the app applies when none is given.
  const calories = num(input.calories) ?? derivedCalories(macros);
  if (calories !== null && calories !== undefined) lines.push(`${calories} kcal${num(input.calories) === undefined ? ' (from macros)' : ''}`);
  const macro = macroLine(macros);
  if (macro) lines.push(macro);
  const extras = MEAL_FIELDS
    .filter(f => ['fiber_g', 'sugar_g', 'fat_saturated_g', 'fat_trans_g', 'alcohol_g'].includes(f.key) && num(input[f.key]) !== undefined)
    .map(f => `${f.label} ${f.show(input[f.key])}`);
  if (extras.length) lines.push(extras.join(' · '));
  if (typeof input.notes === 'string' && input.notes.trim()) lines.push(`Notes: ${text(input.notes)}`);
  return { kind: 'meal', action: 'log', title: text(input.title), lines };
}

function updateMeal(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  const meal = resolveMeal(ctx, input.meal_id);
  if (!meal || !isRecord(input.changes)) return null;
  const lines: string[] = [];
  for (const f of MEAL_FIELDS) {
    if (!(f.key in input.changes)) continue;
    lines.push(`${f.label}: ${f.show(meal[f.field])} → ${f.show(input.changes[f.key])}`);
  }
  return lines.length ? { kind: 'meal', action: 'update', title: text(meal.title), lines } : null;
}

function deleteMeal(input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  const meal = resolveMeal(ctx, input.meal_id);
  if (!meal) return null;
  const lines: string[] = [];
  const when = [formatDate(meal.date), meal.time ? text(meal.time) : null, meal.mealType ? text(meal.mealType) : null]
    .filter(Boolean).join(' · ');
  lines.push(when);
  const calories = mealCalories(meal);
  const macro = macroLine(meal);
  const facts = [calories !== null ? `${calories} kcal` : null, macro].filter(Boolean).join(' · ');
  if (facts) lines.push(facts);
  return { kind: 'meal', action: 'delete', title: text(meal.title), lines };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const PREVIEWS: Record<string, (input: Record<string, unknown>, ctx: CoachToolContext) => ToolPreview | null> = {
  create_event:               createEvent,
  update_event:               updateEvent,
  delete_event:               deleteEvent,
  set_event_exercises:        setEventExercises,
  set_event_completion:       setEventCompletion,
  update_exercise_definition: updateDefinition,
  log_meal:                   logMeal,
  update_meal:                updateMeal,
  delete_meal:                deleteMeal,
};

/**
 * The structured before/after for a pending tool call, or null when there is
 * nothing trustworthy to show (unknown tool, malformed input, a target id
 * that matches no live row). Never throws: the card falls back to its label.
 */
export function previewForTool(name: string, input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null {
  try {
    const build = PREVIEWS[name];
    if (!build || !isRecord(input) || !ctx) return null;
    return build(input, ctx);
  } catch {
    return null;
  }
}
