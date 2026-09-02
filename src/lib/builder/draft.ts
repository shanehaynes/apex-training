import type {
  CardioTargets, ClimbingTargets, Exercise, ExerciseDefinition, ScoringType,
  Sport, WorkoutEvent, WorkoutTemplate, WorkoutType,
} from '../../types/workout';
import type { CreateEventInput, SaveWorkoutTemplateInput, UpdateEventInput } from '../schedule/types';
import { toDisplayTime, toInputTime } from '../time';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import {
  entryFromDefinition, hasPerSideCount, matchDefinitionByName, slugifyName, uniqueEntryId,
} from '../schedule/definitions';
import { normalizeSupersets } from '../schedule/supersets';
import { WEEKDAYS, type Weekday } from '../recurrence/index.js';
import { REPEAT_OFF, repeatFromRule, repeatProblem, ruleFromRepeat, snapAnchorDate, type DraftRepeat } from './repeat';

// ─── The builder's draft model ───────────────────────────────────────────────
// One plain object holding everything the workout builder edits, with pure
// converters to and from the app's persistence shapes. The builder view owns
// a useState<WorkoutDraft>; every input writes here, and Apply reads from
// here — which is also what lets the coach (a later PR) fill the form by
// reducing tool calls onto the same object.
//
// Numeric fields are held as strings deliberately: parseInt-on-change cannot
// represent an empty input, which makes a field impossible to clear. Parsed
// and validated at Apply time.

export type DraftSections = Record<'warmup' | 'exercises' | 'cooldown', Exercise[]>;

export interface WorkoutDraft {
  /** Set when the draft came from (or was title-matched to) a library template. */
  templateId?: string;
  title: string;
  type: WorkoutType;
  /** '' = unspecified. Climbing types force 'climbing' (withType). */
  sport: Sport | '';
  scoringType: ScoringType;
  /** AMRAP only: working-window length in minutes. */
  timeCap: string;
  /** Calendar placement (yyyy-MM-dd; times are HH:mm input values, '' = unset). */
  date: string;
  startTime: string;
  endTime: string;
  duration: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  description: string;
  location: string;
  /** Comma-joined, as typed; parsed at Apply time. */
  tags: string;
  distance: string;
  elevationGain: string;
  avgHeartRate: string;
  maxGrade: string;
  totalPitches: string;
  lists: DraftSections;
  /** Pass-through only — no builder UI edits equipment yet. */
  equipment: string[];
  /** Repeat schedule — a calendar concern, never part of the template. */
  repeat: DraftRepeat;
}

export const TYPE_ORDER: WorkoutType[] = [
  'weights', 'climbing', 'outdoor-climbing', 'cardio', 'yoga', 'stretching', 'morning-routine',
];

/** Library category the exercise picker pre-filters to for each workout type. */
export const TYPE_CATEGORY: Record<WorkoutType, Exercise['category']> = {
  'weights': 'strength',
  'climbing': 'skill',
  'outdoor-climbing': 'climbing',
  'cardio': 'cardio',
  'yoga': 'mobility',
  'stretching': 'stretch',
  'morning-routine': 'mobility',
};

export const TYPE_DURATION: Record<WorkoutType, number> = {
  'weights': 60,
  'climbing': 90,
  'outdoor-climbing': 240,
  'cardio': 45,
  'yoga': 45,
  'stretching': 20,
  'morning-routine': 30,
};

const EMPTY_SECTIONS: DraftSections = { warmup: [], exercises: [], cooldown: [] };

export function emptyDraft(date: string, title = ''): WorkoutDraft {
  return {
    title,
    type: 'weights',
    sport: '',
    scoringType: 'strength',
    timeCap: '',
    date,
    startTime: '',
    endTime: '',
    duration: String(TYPE_DURATION.weights),
    difficulty: 3,
    description: '',
    location: '',
    tags: '',
    distance: '',
    elevationGain: '',
    avgHeartRate: '',
    maxGrade: '',
    totalPitches: '',
    lists: EMPTY_SECTIONS,
    equipment: [],
    repeat: REPEAT_OFF,
  };
}

/**
 * Switch the draft's category. A title the user never customized (empty, or
 * still some type's default label) follows the new type, as does a duration
 * still at some type's default.
 */
export function withType(draft: WorkoutDraft, type: WorkoutType): WorkoutDraft {
  const titleIsDefault = !draft.title || TYPE_ORDER.some(t => draft.title === WORKOUT_COLORS[t].label);
  const durationIsDefault = TYPE_ORDER.some(t => draft.duration === String(TYPE_DURATION[t]));
  const isClimbing = type === 'climbing' || type === 'outdoor-climbing';
  return {
    ...draft,
    type,
    // Climbing types imply the sport; leaving climbing drops the implication
    // (a deliberately picked sport survives type changes).
    sport: isClimbing ? 'climbing' : draft.sport === 'climbing' ? '' : draft.sport,
    title: titleIsDefault ? WORKOUT_COLORS[type].label : draft.title,
    duration: durationIsDefault || !draft.duration ? String(TYPE_DURATION[type]) : draft.duration,
  };
}

export function draftFromTemplate(t: WorkoutTemplate, date: string): WorkoutDraft {
  return {
    templateId: t.id,
    title: t.title,
    type: t.type,
    sport: t.sport ?? '',
    scoringType: t.scoringType,
    timeCap: t.timeCapMinutes != null ? String(t.timeCapMinutes) : '',
    date,
    startTime: '',
    endTime: '',
    duration: String(t.estimatedDuration),
    difficulty: t.difficulty,
    description: t.description,
    location: t.location ?? '',
    tags: t.tags.join(', '),
    distance: t.cardioTargets?.distance ?? '',
    elevationGain: t.cardioTargets?.elevationGain ?? '',
    avgHeartRate: t.cardioTargets?.avgHeartRate != null ? String(t.cardioTargets.avgHeartRate) : '',
    maxGrade: t.climbingTargets?.maxGrade ?? '',
    totalPitches: t.climbingTargets?.totalPitches != null ? String(t.climbingTargets.totalPitches) : '',
    lists: { warmup: t.warmup ?? [], exercises: t.exercises, cooldown: t.cooldown ?? [] },
    equipment: t.equipment ?? [],
    repeat: REPEAT_OFF,
  };
}

export function draftFromEvent(e: WorkoutEvent): WorkoutDraft {
  return {
    templateId: e.templateId,
    title: e.title,
    type: e.type,
    sport: e.sport ?? '',
    scoringType: e.scoringType ?? 'strength',
    timeCap: e.timeCapMinutes != null ? String(e.timeCapMinutes) : '',
    date: e.date,
    startTime: toInputTime(e.startTime),
    endTime: toInputTime(e.endTime),
    duration: String(e.estimatedDuration),
    difficulty: e.difficulty,
    description: e.description,
    location: e.location ?? '',
    tags: e.tags.join(', '),
    distance: e.cardioTargets?.distance ?? '',
    elevationGain: e.cardioTargets?.elevationGain ?? '',
    avgHeartRate: e.cardioTargets?.avgHeartRate != null ? String(e.cardioTargets.avgHeartRate) : '',
    maxGrade: e.climbingTargets?.maxGrade ?? '',
    totalPitches: e.climbingTargets?.totalPitches != null ? String(e.climbingTargets.totalPitches) : '',
    lists: { warmup: e.warmup ?? [], exercises: e.exercises, cooldown: e.cooldown ?? [] },
    equipment: e.equipment ?? [],
    repeat: repeatFromRule(e.isRecurring ? e.recurrenceRule : undefined),
  };
}

/** First user-facing validation problem, or null when the draft can save. */
export function draftProblem(draft: WorkoutDraft): string | null {
  if (!draft.title.trim()) return 'Give the workout a title';
  const duration = parseInt(draft.duration, 10);
  if (!Number.isFinite(duration) || duration <= 0) return 'Duration must be a positive number of minutes';
  if (draft.scoringType === 'amrap') {
    const cap = parseInt(draft.timeCap, 10);
    if (!Number.isFinite(cap) || cap <= 0) return 'AMRAP needs a time cap in minutes';
  }
  return repeatProblem(draft.repeat, draft.date);
}

function parsedTags(draft: WorkoutDraft): string[] {
  return draft.tags.split(',').map(t => t.trim()).filter(Boolean);
}

function packedTimeCap(draft: WorkoutDraft): number | undefined {
  if (draft.scoringType !== 'amrap') return undefined;
  const cap = parseInt(draft.timeCap, 10);
  return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

function packedCardio(draft: WorkoutDraft): CardioTargets | undefined {
  if (draft.type !== 'cardio') return undefined;
  const hr = parseInt(draft.avgHeartRate, 10);
  const targets: CardioTargets = {
    distance: draft.distance.trim() || undefined,
    elevationGain: draft.elevationGain.trim() || undefined,
    avgHeartRate: Number.isFinite(hr) && hr > 0 ? hr : undefined,
  };
  return Object.values(targets).some(v => v !== undefined) ? targets : undefined;
}

function packedClimbing(draft: WorkoutDraft): ClimbingTargets | undefined {
  if (draft.type !== 'outdoor-climbing') return undefined;
  // Only explicitly entered targets persist — blank fields stay derived from
  // the pitch list wherever the event is displayed.
  const pitches = parseInt(draft.totalPitches, 10);
  const targets: ClimbingTargets = {
    maxGrade: draft.maxGrade.trim() || undefined,
    totalPitches: Number.isFinite(pitches) && pitches > 0 ? pitches : undefined,
  };
  return Object.values(targets).some(v => v !== undefined) ? targets : undefined;
}

/**
 * The library upsert for Apply. No id: the caller resolves identity first
 * (draft.templateId, else matchTemplateByTitle, else saveTemplate mints).
 */
export function templateInputFromDraft(draft: WorkoutDraft): Omit<SaveWorkoutTemplateInput, 'id'> {
  return {
    title: draft.title.trim(),
    type: draft.type,
    sport: draft.sport || undefined,
    scoringType: draft.scoringType,
    timeCapMinutes: packedTimeCap(draft),
    estimatedDuration: parseInt(draft.duration, 10),
    difficulty: draft.difficulty,
    description: draft.description.trim(),
    warmup: draft.lists.warmup.length ? draft.lists.warmup : undefined,
    exercises: draft.lists.exercises,
    cooldown: draft.lists.cooldown.length ? draft.lists.cooldown : undefined,
    location: draft.location.trim() || undefined,
    tags: parsedTags(draft),
    equipment: draft.equipment,
    cardioTargets: packedCardio(draft),
    climbingTargets: packedClimbing(draft),
  };
}

/** The calendar event for Apply, referencing the just-upserted template. */
export function createInputFromDraft(draft: WorkoutDraft, templateId: string): CreateEventInput {
  const rule = ruleFromRepeat(draft.repeat);
  return {
    type: draft.type,
    sport: draft.sport || undefined,
    title: draft.title.trim(),
    date: rule && !draft.repeat.custom ? snapAnchorDate(draft.date, draft.repeat.days) : draft.date,
    recurrenceRule: rule,
    estimatedDuration: parseInt(draft.duration, 10),
    difficulty: draft.difficulty,
    startTime: draft.startTime ? toDisplayTime(draft.startTime) ?? undefined : undefined,
    endTime: draft.endTime ? toDisplayTime(draft.endTime) ?? undefined : undefined,
    description: draft.description.trim() || undefined,
    location: draft.location.trim() || undefined,
    tags: parsedTags(draft),
    equipment: draft.equipment.length ? draft.equipment : undefined,
    exercises: draft.lists.exercises,
    warmup: draft.lists.warmup.length ? draft.lists.warmup : undefined,
    cooldown: draft.lists.cooldown.length ? draft.lists.cooldown : undefined,
    cardioTargets: packedCardio(draft),
    climbingTargets: packedClimbing(draft),
    templateId,
    scoringType: draft.scoringType,
    timeCapMinutes: packedTimeCap(draft),
  };
}

/**
 * Edit-mode fields for updateEvent. Only the fields the builder edits — the
 * absent keys (subtitle, coverImageUrl, source…) stay untouched.
 * includeSchedule=false skips date/times: a recurring series is edited
 * series-wide, where the anchor date must not follow the opened occurrence.
 *
 * Repeat: an enabled weekly picker writes the rule (series scope rewrites
 * the pattern; a one-off with schedule becomes a series on its snapped
 * anchor). A custom rule and a disabled picker both leave recurrence
 * untouched — the picker can neither rewrite what it can't express nor end
 * a series (that's the modal's delete, or an Ends date).
 */
export function eventFieldsFromDraft(
  draft: WorkoutDraft,
  { includeSchedule }: { includeSchedule: boolean },
): UpdateEventInput['fields'] {
  const rule = ruleFromRepeat(draft.repeat);
  const writesRule = draft.repeat.enabled && !draft.repeat.custom && !!rule;
  return {
    title: draft.title.trim(),
    type: draft.type,
    // Explicit null so unsetting the sport clears the column — undefined
    // keys are skipped by eventFieldsToRow, which would leave it stale.
    sport: (draft.sport || null) as unknown as WorkoutEvent['sport'],
    estimatedDuration: parseInt(draft.duration, 10),
    difficulty: draft.difficulty,
    description: draft.description.trim(),
    location: draft.location.trim() || undefined,
    tags: parsedTags(draft),
    exercises: draft.lists.exercises,
    warmup: draft.lists.warmup.length ? draft.lists.warmup : undefined,
    cooldown: draft.lists.cooldown.length ? draft.lists.cooldown : undefined,
    cardioTargets: packedCardio(draft),
    climbingTargets: packedClimbing(draft),
    scoringType: draft.scoringType,
    timeCapMinutes: packedTimeCap(draft),
    ...(writesRule ? { recurrenceRule: rule } : {}),
    ...(includeSchedule
      ? {
          date: writesRule ? snapAnchorDate(draft.date, draft.repeat.days) : draft.date,
          startTime: draft.startTime ? toDisplayTime(draft.startTime) ?? undefined : undefined,
          endTime: draft.endTime ? toDisplayTime(draft.endTime) ?? undefined : undefined,
          ...(writesRule ? { isRecurring: true } : {}),
        }
      : {}),
  };
}

// ─── Coach integration ───────────────────────────────────────────────────────
// The builder's coach thread edits the draft through exactly one tool
// (update_workout_draft — see src/lib/coach/schemas.ts). applyDraftUpdate is
// its executor: a pure reducer over the draft, side-effect free by design —
// unmatched exercise names stay snapshot-only entries, and library
// definitions are created only when the USER applies.

/** One exercise as the model supplies it (EXERCISE_INPUT_SCHEMA shape). */
export interface DraftExerciseInput {
  name: string;
  category?: Exercise['category'];
  muscle_groups?: string[];
  sets?: number;
  reps?: string;
  duration?: string;
  weight?: string;
  rest_period?: string;
  superset?: string;
  notes?: string;
  climb_style?: Exercise['climbStyle'];
  grade?: string;
  ascent_style?: Exercise['ascentStyle'];
}

export interface DraftUpdateInput {
  title?: string;
  type?: WorkoutType;
  /** null clears (back to unspecified); climbing types force 'climbing'. */
  sport?: Sport | null;
  scoring_type?: ScoringType;
  time_cap_minutes?: number;
  date?: string;
  start_time?: string;
  end_time?: string;
  duration_minutes?: number;
  difficulty?: number;
  description?: string;
  location?: string;
  tags?: string[];
  warmup?: DraftExerciseInput[];
  exercises?: DraftExerciseInput[];
  cooldown?: DraftExerciseInput[];
  repeat?: { days?: string[]; interval_weeks?: number; until?: string; off?: boolean };
}

function draftEntriesFromInputs(
  inputs: DraftExerciseInput[],
  definitions: Map<string, ExerciseDefinition>,
  takenIds: string[],
): Exercise[] {
  const entries: Exercise[] = [];
  for (const input of inputs) {
    const overrides = {
      sets: input.sets, reps: input.reps, duration: input.duration,
      weight: input.weight, restPeriod: input.rest_period, notes: input.notes,
      superset: input.superset,
      climbStyle: input.climb_style, grade: input.grade, ascentStyle: input.ascent_style,
    };
    const def = matchDefinitionByName(input.name, definitions.values());
    const id = uniqueEntryId(def?.id ?? slugifyName(input.name), [...takenIds, ...entries.map(e => e.id)]);
    entries.push(def
      ? entryFromDefinition(def, id, overrides)
      // No library write from the coach's draft edits: a name that matches
      // nothing stays a snapshot entry until the user applies.
      : { id, name: input.name, category: input.category ?? 'strength', ...overrides });
  }
  return normalizeSupersets(entries);
}

/**
 * Apply one update_workout_draft call. Returns the next draft plus a
 * tool_result line, or an instructive error (per-side counts, like the
 * calendar tools) so the model restates instead of polluting the form.
 */
export function applyDraftUpdate(
  draft: WorkoutDraft,
  input: DraftUpdateInput,
  definitions: Map<string, ExerciseDefinition>,
): { draft: WorkoutDraft; summary: string } | { error: string } {
  const sections: Array<'warmup' | 'exercises' | 'cooldown'> = ['warmup', 'exercises', 'cooldown'];

  const violations: string[] = [];
  for (const key of sections) {
    for (const entry of input[key] ?? []) {
      const def = matchDefinitionByName(entry.name, definitions.values());
      const counted = entry.reps ?? entry.duration;
      if (def?.isUnilateral && counted && !hasPerSideCount(counted)) {
        violations.push(`${def.canonicalName}: "${counted}" — state the count per side ("${counted} each side") or as "total".`);
      }
    }
  }
  if (violations.length) {
    return { error: `Unilateral exercises need per-side counts. Fix and retry:\n${violations.join('\n')}` };
  }

  const changed: string[] = [];
  let next = { ...draft, lists: { ...draft.lists } };
  const set = <K extends keyof WorkoutDraft>(key: K, value: WorkoutDraft[K], label: string) => {
    next = { ...next, [key]: value };
    changed.push(label);
  };

  if (typeof input.title === 'string' && input.title.trim()) set('title', input.title.trim(), 'title');
  if (input.type && input.type in WORKOUT_COLORS) {
    set('type', input.type, 'category');
    // Same implication withType applies in the form: climbing types ARE the
    // climbing sport; leaving them drops the implied value.
    if (input.type === 'climbing' || input.type === 'outdoor-climbing') next = { ...next, sport: 'climbing' };
    else if (next.sport === 'climbing') next = { ...next, sport: '' };
  }
  if (input.sport !== undefined) {
    const isClimbingType = next.type === 'climbing' || next.type === 'outdoor-climbing';
    if (isClimbingType) {
      // The type already decided this — acknowledge instead of erroring so
      // a sport-only update still yields an instructive tool_result.
      next = { ...next, sport: 'climbing' };
      changed.push('sport (climbing types imply it — unchanged)');
    } else if (input.sport === null) {
      set('sport', '', 'sport cleared');
    } else if (['running', 'biking', 'swimming', 'other'].includes(input.sport)) {
      set('sport', input.sport, 'sport');
    }
  }
  if (input.scoring_type === 'strength' || input.scoring_type === 'for-time' || input.scoring_type === 'amrap') {
    set('scoringType', input.scoring_type, 'scoring');
  }
  if (typeof input.time_cap_minutes === 'number' && input.time_cap_minutes > 0) {
    set('timeCap', String(Math.round(input.time_cap_minutes)), 'time cap');
  }
  if (typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) set('date', input.date, 'date');
  if (typeof input.start_time === 'string' && /^\d{2}:\d{2}$/.test(input.start_time)) set('startTime', input.start_time, 'start time');
  if (typeof input.end_time === 'string' && /^\d{2}:\d{2}$/.test(input.end_time)) set('endTime', input.end_time, 'end time');
  if (typeof input.duration_minutes === 'number' && input.duration_minutes > 0) {
    set('duration', String(Math.round(input.duration_minutes)), 'duration');
  }
  if (typeof input.difficulty === 'number' && input.difficulty >= 1 && input.difficulty <= 5) {
    set('difficulty', Math.round(input.difficulty) as WorkoutDraft['difficulty'], 'difficulty');
  }
  if (typeof input.description === 'string') set('description', input.description, 'description');
  if (typeof input.location === 'string') set('location', input.location, 'location');
  if (Array.isArray(input.tags)) set('tags', input.tags.filter(t => typeof t === 'string').join(', '), 'tags');

  for (const key of sections) {
    const inputs = input[key];
    if (!inputs) continue;
    const takenIds = sections.filter(s => s !== key).flatMap(s => next.lists[s].map(e => e.id));
    next = { ...next, lists: { ...next.lists, [key]: draftEntriesFromInputs(inputs, definitions, takenIds) } };
    changed.push(`${key} (${inputs.length})`);
  }

  if (input.repeat) {
    if (input.repeat.off) {
      set('repeat', REPEAT_OFF, 'repeat off');
    } else {
      const days = (input.repeat.days ?? []).filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d));
      if (!days.length) return { error: 'repeat needs at least one day (MO–SU), or { off: true }.' };
      const interval = input.repeat.interval_weeks;
      set('repeat', {
        enabled: true,
        days,
        interval: String(typeof interval === 'number' && interval >= 1 ? Math.round(interval) : 1),
        until: typeof input.repeat.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.repeat.until) ? input.repeat.until : '',
      }, 'repeat');
    }
  }

  if (!changed.length) return { error: 'Nothing recognized in the update — pass at least one field.' };
  return { draft: next, summary: `Draft updated: ${changed.join(', ')}. The user reviews and presses Apply.` };
}

/** Compact text form of the live draft for the builder coach's prompt. */
export function describeDraft(draft: WorkoutDraft): string {
  const lines = [
    `Title: ${draft.title || '(untitled)'}`,
    `Category: ${WORKOUT_COLORS[draft.type].label}${draft.sport ? ` · sport ${draft.sport}` : ''}`,
    `Scoring: ${draft.scoringType}${draft.scoringType === 'amrap' && draft.timeCap ? ` (cap ${draft.timeCap} min)` : ''}`,
    `Date: ${draft.date}${draft.startTime ? ` ${draft.startTime}` : ''}${draft.endTime ? `–${draft.endTime}` : ''} · ${draft.duration || '?'} min · difficulty ${draft.difficulty}`,
  ];
  if (draft.repeat.enabled) {
    lines.push(`Repeat: ${draft.repeat.custom ?? `${draft.repeat.days.join(',')} every ${draft.repeat.interval} week(s)${draft.repeat.until ? ` until ${draft.repeat.until}` : ''}`}`);
  }
  if (draft.location) lines.push(`Location: ${draft.location}`);
  if (draft.tags) lines.push(`Tags: ${draft.tags}`);
  if (draft.description) lines.push(`Description: ${draft.description}`);
  for (const key of ['warmup', 'exercises', 'cooldown'] as const) {
    const entries = draft.lists[key];
    if (!entries.length) continue;
    lines.push(`${key === 'exercises' ? 'Main work' : key === 'warmup' ? 'Warm-up' : 'Cool-down'}:`);
    for (const e of entries) {
      const spec = [
        e.sets ? `${e.sets}×` : '',
        e.reps ?? e.duration ?? '',
        e.weight ? `@ ${e.weight}` : '',
        e.superset ? `[superset ${e.superset}]` : '',
      ].filter(Boolean).join(' ');
      lines.push(`  - ${e.name}${spec ? ` — ${spec}` : ''}`);
    }
  }
  return lines.join('\n');
}
