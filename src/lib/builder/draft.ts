import type {
  CardioTargets, ClimbingTargets, Exercise, ScoringType,
  WorkoutEvent, WorkoutTemplate, WorkoutType,
} from '../../types/workout';
import type { CreateEventInput, SaveWorkoutTemplateInput, UpdateEventInput } from '../schedule/types';
import { toDisplayTime, toInputTime } from '../time';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
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
  return {
    ...draft,
    type,
    title: titleIsDefault ? WORKOUT_COLORS[type].label : draft.title,
    duration: durationIsDefault || !draft.duration ? String(TYPE_DURATION[type]) : draft.duration,
  };
}

export function draftFromTemplate(t: WorkoutTemplate, date: string): WorkoutDraft {
  return {
    templateId: t.id,
    title: t.title,
    type: t.type,
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
