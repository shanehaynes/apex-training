import { randomUUID } from 'node:crypto';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchAllPages } from '../pagination.js';
import { fetchDefinitionRows } from '../mcp/data.js';
import { quickCompletePlan } from '../trackerSession.js';
import * as events from './events.js';
import { detachInstance } from './eventInstances.js';
import { upsertTemplate } from './templates.js';
import { recordCompletion } from './completions.js';
import { fail, succeed, type ServiceResult } from './result.js';
import {
  createInputFromDraft, draftProblem, eventFieldsFromDraft, templateInputFromDraft, type WorkoutDraft,
} from '../../../src/lib/builder/draft.js';
import { REPEAT_OFF } from '../../../src/lib/builder/repeat.js';
import { rowToDefinition, validateUnilateral } from '../../../src/lib/schedule/definitions.js';
import { buildCompletionRows, eventFieldsToRow, eventFromCreateInput, eventToRow, rowToEvent } from '../../../src/lib/schedule/mapping.js';
import { baseIdOf, occurrenceDateOf } from '../../../src/lib/schedule/occurrence.js';
import { matchTemplateByTitle, mintTemplateId, rowToTemplate, templateToRow } from '../../../src/lib/schedule/templates.js';
import type { WorkoutEventRow, WorkoutTemplateRow } from '../../../src/lib/db/types.js';
import type { WorkoutEvent } from '../../../src/types/workout.js';

// The builder's Apply, server-side (docs/ios/backend-changes.md, W7). The web
// runs this sequence in WorkoutBuilderView.tsx over ScheduleContext; a native
// client sends the same WorkoutDraft JSON it hands /api/coach-tool and the
// server does the rest with the same pure functions (src/lib/builder/draft.ts)
// and the same services the HTTP handlers use — so nothing about templates,
// row shapes, anchor snapping or retro-logging is reimplemented in Swift.
//
//   create  → upsert the template (existing id › case-insensitive title › a
//             fresh wt- id), then insert the event referencing it; a one-off
//             on a past date is a retro-log and completes on creation.
//   update  → PATCH the base: a one-off with its schedule, a series without
//             (the anchor must not follow whichever occurrence was opened).
//   detach  → the edits become a standalone event and the occurrence leaves
//             the series; the repeat picker never applies to a detached day.
//
// User-facing validation (the toasts the web shows before it saves) comes
// back as `{ ok: false, problem }` on 200 so the client keeps the text and the
// per-entry violations; 4xx is for malformed requests, ownership and failures.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export type WorkoutDraftAction =
  | { kind: 'create' }
  | { kind: 'update'; eventId: string }
  | { kind: 'detach'; eventId: string; occurrenceDate: string };

export interface WorkoutDraftBody {
  draft: WorkoutDraft;
  today: string;
  action: WorkoutDraftAction;
}

export type WorkoutDraftOutcome =
  | { ok: false; problem: string; violations?: Record<string, string> }
  | {
      ok: true;
      action: WorkoutDraftAction['kind'];
      /** The event written: the new row's id for create/detach, the base id for update. */
      id: string;
      templateId?: string;
      date: string;
      completedOnCreate: boolean;
      isRecurring: boolean;
      /** detach only: the series the occurrence left, and the date it was keyed on. */
      detachedFrom?: string;
      occurrenceDate?: string;
      /** The event as `/api/schedule` would serve its base — the client can place it without a refetch. */
      event: WorkoutEvent;
    };

export const UNILATERAL_PROBLEM = 'Per-side counts needed for unilateral exercises';

async function loadDefinitions(supabase: Admin, userId: string) {
  const rows = await fetchDefinitionRows(supabase, userId);
  return new Map(rows.map(r => [r.id, rowToDefinition(r)]));
}

async function loadTemplates(supabase: Admin, userId: string) {
  const rows = await fetchAllPages<WorkoutTemplateRow>('workout_templates', (from, to) =>
    supabase.from('workout_templates').select('*').eq('user_id', userId).order('title', { ascending: true }).range(from, to),
  );
  return rows.map(rowToTemplate);
}

async function loadBaseRow(supabase: Admin, userId: string, baseId: string): Promise<ServiceResult<WorkoutEventRow>> {
  const { data, error } = await supabase
    .from('workout_events')
    .select('*')
    .eq('id', baseId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[api/workout-draft] event lookup failed:', error.message);
    return fail(500, 'Failed to load event');
  }
  if (!data) return fail(404, 'Event not found');
  return succeed(data as WorkoutEventRow);
}

export async function applyWorkoutDraft(
  supabase: Admin,
  userId: string,
  body: WorkoutDraftBody,
): Promise<ServiceResult<WorkoutDraftOutcome>> {
  const { draft, today, action } = body;

  const baseId = action.kind === 'create' ? null : baseIdOf(action.eventId);
  const [definitions, templates, base] = await Promise.all([
    loadDefinitions(supabase, userId),
    action.kind === 'create' ? loadTemplates(supabase, userId) : Promise.resolve([]),
    baseId ? loadBaseRow(supabase, userId, baseId) : Promise.resolve(null),
  ]);
  if (base && !base.ok) return base;
  const row = base?.ok ? base.value : null;
  if (action.kind === 'detach' && row && !row.is_recurring) {
    return fail(400, 'Only a recurring workout has an occurrence to detach');
  }

  // The web's validate(): the draft's own problem first, then per-entry
  // unilateral counts. Both are pure and throw only on a malformed draft.
  let problem: string | null;
  let violations: Map<string, string>;
  try {
    problem = draftProblem(draft);
    violations = validateUnilateral(draft.lists, definitions);
  } catch {
    return fail(400, 'draft is not a valid draft');
  }
  if (problem) return succeed({ ok: false, problem });
  if (violations.size > 0) {
    return succeed({ ok: false, problem: UNILATERAL_PROBLEM, violations: Object.fromEntries(violations) });
  }

  if (action.kind === 'create') {
    // Identity resolution before the upsert: the picked template's id, else a
    // case-insensitive title match (reapplying an archived title revives it,
    // reconnecting its score history), else a fresh id.
    const templateId = draft.templateId ?? matchTemplateByTitle(templates, draft.title)?.id ?? mintTemplateId();
    const saved = await upsertTemplate(
      supabase, userId,
      templateToRow({ id: templateId, ...templateInputFromDraft(draft) }) as unknown as Record<string, unknown>,
    );
    if (!saved.ok) return saved;

    const input = createInputFromDraft(draft, templateId);
    const id = `ai-${randomUUID()}`;
    // An event added to a day that has already passed is a retro-log: it was
    // done, not planned, so it completes on creation. A recurring series is a
    // plan whatever its anchor date — never that.
    const completedOnCreate = input.date < today && !input.recurrenceRule;
    const newEvent = eventFromCreateInput(input, id, completedOnCreate);
    const created = await events.createEvent(supabase, userId, eventToRow(newEvent) as unknown as Record<string, unknown>, 'user');
    if (!created.ok) return created;
    if (completedOnCreate) {
      // Best-effort, like the browser's fire-and-forget: the event exists
      // either way, and the calendar toggle can repair completion state.
      const rows = buildCompletionRows(newEvent, true);
      await recordCompletion(
        supabase, userId,
        rows.completionRow as unknown as Record<string, unknown>,
        rows.logRow as unknown as Record<string, unknown>,
      ).catch(err => console.warn('[api/workout-draft] retro-log completion failed:', err));
      await quickCompletePlan(supabase, userId, newEvent)
        .catch(err => console.warn('[api/workout-draft] retro-log quick-complete failed:', err));
    }
    return succeed({
      ok: true, action: 'create', id, templateId, date: newEvent.date, completedOnCreate,
      isRecurring: newEvent.isRecurring, event: newEvent,
    });
  }

  const current = rowToEvent(row!);

  if (action.kind === 'update') {
    // Series-wide (or a plain one-off): the anchor date/times of a series
    // must not follow whichever occurrence happened to be opened.
    const fields = eventFieldsFromDraft(draft, { includeSchedule: !current.isRecurring });
    const updated = await events.updateEvent(supabase, userId, current.id, eventFieldsToRow(fields) as Record<string, unknown>, {
      event_title: fields.title ?? current.title,
      event_date: fields.date ?? current.date,
      diff: { before: current, after: fields } as never,
      triggered_by: 'user',
    });
    if (!updated.ok) return updated;
    const event: WorkoutEvent = { ...current, ...(fields as Partial<WorkoutEvent>) };
    return succeed({
      ok: true, action: 'update', id: current.id, templateId: current.templateId, date: event.date,
      completedOnCreate: false, isRecurring: !!event.isRecurring, event,
    });
  }

  // Detach: the edits (schedule included) become a standalone event and this
  // day leaves the series. The exception row keys on the occurrence's
  // originally generated date, which the id carries for every occurrence but
  // the anchor — the caller supplies that one (originalDate on the stub).
  const keyDate = occurrenceDateOf(action.eventId) ?? action.occurrenceDate;
  const fields = eventFieldsFromDraft({ ...draft, repeat: REPEAT_OFF }, { includeSchedule: true });
  const standalone: WorkoutEvent = {
    ...current,
    ...(fields as Partial<WorkoutEvent>),
    id: `ai-${randomUUID()}`,
    date: fields.date ?? current.date,
    isRecurring: false,
    recurrenceRule: undefined,
    recurringPattern: undefined,
    isCompleted: false,
  };
  const detached = await detachInstance(
    supabase, userId,
    { eventId: current.id, date: keyDate, eventTitle: standalone.title, triggeredBy: 'user' },
    eventToRow(standalone) as unknown as Record<string, unknown>,
  );
  if (!detached.ok) return detached;
  return succeed({
    ok: true, action: 'detach', id: standalone.id, templateId: standalone.templateId, date: standalone.date,
    completedOnCreate: false, isRecurring: false, detachedFrom: current.id, occurrenceDate: keyDate, event: standalone,
  });
}
