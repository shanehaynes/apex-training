// What POST /api/workout-draft answers in the mock profile — the builder's
// Apply, which since #136 is the web's only write path out of the form.
//
// This replays api/_lib/services/workoutDraft.ts over the SAME pure functions
// the server runs, so refusals, minted ids and response shapes are the real
// contract rather than a spec-shaped guess. (The precedent is intercept.mjs
// building the tracker model from src/lib/tracking/plan.ts.) Playwright's
// loader resolves these TS modules and their .js-specifier internals.

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createInputFromDraft, draftProblem, eventFieldsFromDraft,
} from '../../../src/lib/builder/draft.ts';
import { REPEAT_OFF } from '../../../src/lib/builder/repeat.ts';
import { validateUnilateral } from '../../../src/lib/schedule/definitions.ts';
import { normalizeSeedEvent } from '../../../src/lib/schedule/expand.ts';
import { eventFromCreateInput } from '../../../src/lib/schedule/mapping.ts';
import { baseIdOf, occurrenceDateOf } from '../../../src/lib/schedule/occurrence.ts';
import { matchTemplateByTitle, mintTemplateId } from '../../../src/lib/schedule/templates.ts';

// The same bundled seed the calendar falls back to, so an id the page holds
// resolves here to the row the user is actually looking at.
const seedSchedule = createRequire(import.meta.url)('../../../src/data/schedule.json');
const SEED_EVENTS = seedSchedule.events.map(normalizeSeedEvent);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors UNILATERAL_PROBLEM in api/_lib/services/workoutDraft.ts. */
const UNILATERAL_PROBLEM = 'Per-side counts needed for unilateral exercises';

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A 4xx, sent as plain text exactly as the handler sends it. */
const refuse = (status, text) => ({ status, body: text });
/** A 200 — both `ok: true` and the builder's own `ok: false` refusals. */
const answer = body => ({ status: 200, body });

/** The action, or the 400 text explaining what was wrong with it. */
function parseAction(value) {
  if (!isObject(value)) return 'Unknown action';
  const kind = value.kind;
  if (kind === 'create') return { kind };
  if (kind !== 'update' && kind !== 'detach') return 'Unknown action';
  if (typeof value.eventId !== 'string' || !value.eventId) return 'Missing eventId';
  if (kind === 'update') return { kind, eventId: value.eventId };
  if (typeof value.occurrenceDate !== 'string' || !DATE_RE.test(value.occurrenceDate)) {
    return 'occurrenceDate must be a YYYY-MM-DD date';
  }
  return { kind, eventId: value.eventId, occurrenceDate: value.occurrenceDate };
}

/**
 * Answer one POST /api/workout-draft.
 *
 * `definitions` (id → ExerciseDefinition) and `templates` default empty,
 * matching the context-level REST stubs for exercise_definitions and
 * workout_templates; a spec that wants a unilateral refusal or a
 * title-match revival passes its own.
 *
 * @returns {{ status: number, body: object | string }} 200 + the outcome
 *   JSON, or a 4xx + its plain-text message.
 */
export function workoutDraftResponse(
  body,
  { definitions = new Map(), templates = [], events = SEED_EVENTS } = {},
) {
  // ── The door (api/_lib/handlers/workoutDraft.ts) ──
  if (!isObject(body?.draft)) return refuse(400, 'draft must be an object');
  if (typeof body.today !== 'string' || !DATE_RE.test(body.today)) {
    return refuse(400, 'today must be a YYYY-MM-DD date');
  }
  const action = parseAction(body.action);
  if (typeof action === 'string') return refuse(400, action);

  // ── The orchestration (api/_lib/services/workoutDraft.ts) ──
  // Ownership and the detach precondition are checked before validation, so
  // an unknown event 404s whatever the draft says.
  const draft = body.draft;
  const current = action.kind === 'create'
    ? null
    : events.find(e => e.id === baseIdOf(action.eventId));
  if (action.kind !== 'create' && !current) return refuse(404, 'Event not found');
  if (action.kind === 'detach' && !current.isRecurring) {
    return refuse(400, 'Only a recurring workout has an occurrence to detach');
  }

  // The web's old validate(): the draft's own problem first, then per-entry
  // unilateral counts. Both are pure and throw only on a malformed draft.
  let problem;
  let violations;
  try {
    problem = draftProblem(draft);
    violations = validateUnilateral(draft.lists, definitions);
  } catch {
    return refuse(400, 'draft is not a valid draft');
  }
  if (problem) return answer({ ok: false, problem });
  if (violations.size > 0) {
    return answer({ ok: false, problem: UNILATERAL_PROBLEM, violations: Object.fromEntries(violations) });
  }

  if (action.kind === 'create') {
    // Identity resolution before the upsert: the picked template's id, else a
    // case-insensitive title match, else a fresh id.
    const templateId = draft.templateId ?? matchTemplateByTitle(templates, draft.title)?.id ?? mintTemplateId();
    const input = createInputFromDraft(draft, templateId);
    const id = `ai-${randomUUID()}`;
    // A one-off on a day that has already passed is a retro-log; a series is
    // a plan whatever its anchor date.
    const completedOnCreate = input.date < body.today && !input.recurrenceRule;
    const event = eventFromCreateInput(input, id, completedOnCreate);
    return answer({
      ok: true, action: 'create', id, templateId, date: event.date, completedOnCreate,
      isRecurring: event.isRecurring, event,
    });
  }

  if (action.kind === 'update') {
    // Series-wide (or a plain one-off): the anchor date/times of a series
    // must not follow whichever occurrence happened to be opened.
    const fields = eventFieldsFromDraft(draft, { includeSchedule: !current.isRecurring });
    const event = { ...current, ...fields };
    return answer({
      ok: true, action: 'update', id: current.id, templateId: current.templateId, date: event.date,
      completedOnCreate: false, isRecurring: !!event.isRecurring, event,
    });
  }

  // Detach: the edits (schedule included) become a standalone event keyed at
  // the occurrence's originally generated date — which the id carries for
  // every occurrence but the anchor, whose date the caller supplies.
  const keyDate = occurrenceDateOf(action.eventId) ?? action.occurrenceDate;
  const fields = eventFieldsFromDraft({ ...draft, repeat: REPEAT_OFF }, { includeSchedule: true });
  const event = {
    ...current,
    ...fields,
    id: `ai-${randomUUID()}`,
    date: fields.date ?? current.date,
    isRecurring: false,
    recurrenceRule: undefined,
    recurringPattern: undefined,
    isCompleted: false,
  };
  return answer({
    ok: true, action: 'detach', id: event.id, templateId: event.templateId, date: event.date,
    completedOnCreate: false, isRecurring: false, detachedFrom: current.id, occurrenceDate: keyDate, event,
  });
}
