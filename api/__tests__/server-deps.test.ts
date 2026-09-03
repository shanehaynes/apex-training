import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerDeps } from '../_lib/coach/serverDeps';
import * as events from '../_lib/services/events';
import * as instances from '../_lib/services/eventInstances';
import * as definitions from '../_lib/services/definitions';
import * as mealsSvc from '../_lib/services/meals';
import { recordCompletion } from '../_lib/services/completions';
import { quickCompletePlan } from '../_lib/trackerSession';
import type { ExerciseDefinition, WorkoutEvent } from '../../src/types/workout';
import type { Meal } from '../../src/types/nutrition';

vi.mock('../_lib/services/events.js', () => ({
  createEvent: vi.fn(async () => ({ ok: true, value: { id: 'x' } })),
  updateEvent: vi.fn(async () => ({ ok: true, value: undefined })),
  deleteEvent: vi.fn(async () => ({ ok: false, status: 404, message: 'Event not found' })),
}));
vi.mock('../_lib/services/eventInstances.js', () => ({
  skipInstance: vi.fn(async () => ({ ok: true, value: undefined })),
  rescheduleInstance: vi.fn(async () => ({ ok: true, value: undefined })),
  detachInstance: vi.fn(),
}));
vi.mock('../_lib/services/definitions.js', () => ({
  createDefinition: vi.fn(async () => ({ ok: true, value: { id: 'x' } })),
  updateDefinition: vi.fn(async () => ({ ok: true, value: undefined })),
}));
vi.mock('../_lib/services/meals.js', () => ({
  createMeal: vi.fn(async () => ({ ok: true, value: { id: 'x' } })),
  updateMeal: vi.fn(async () => ({ ok: true, value: undefined })),
  deleteMeal: vi.fn(async () => ({ ok: true, value: undefined })),
}));
vi.mock('../_lib/services/completions.js', () => ({ recordCompletion: vi.fn(async () => ({ ok: true, value: undefined })) }));
vi.mock('../_lib/trackerSession.js', () => ({ quickCompletePlan: vi.fn(async () => ({ ok: true, value: undefined })) }));

const existingOverride = { override_date: null, override_start_time: '06:00', override_end_time: null };
function makeAdmin() {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: existingOverride, error: null }) };
  return { from: () => chain } as never;
}

const series: WorkoutEvent = {
  id: 'evt-weekly', type: 'weights', title: 'Bench', date: '2026-09-01', estimatedDuration: 60, description: '',
  exercises: [], difficulty: 3, tags: [], isCompleted: false, isRecurring: true, recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
};
const oneOff: WorkoutEvent = { ...series, id: 'evt-solo', title: 'Long run', isRecurring: false, recurrenceRule: undefined, date: '2026-09-10' };

function makeDeps() {
  const ctx = {
    today: '2026-09-03',
    events: [series, { ...series, id: 'evt-weekly__2026-09-08', date: '2026-09-08' }, oneOff],
    definitions: new Map<string, ExerciseDefinition>(),
    meals: [] as Meal[],
  };
  return { deps: createServerDeps(makeAdmin(), 'user-1', ctx), ctx };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('createServerDeps — what the browser did for the coach, on the server', () => {
  it('createEvent mints an ai- id, stamps ai attribution, and retro-logs a past-dated one-off', async () => {
    const { deps, ctx } = makeDeps();
    const result = await deps.createEvent({ type: 'cardio', title: 'Easy run', date: '2026-09-01', estimatedDuration: 30 });
    expect(result?.id).toMatch(/^ai-[0-9a-f-]{36}$/);
    const [, userId, row, triggeredBy] = vi.mocked(events.createEvent).mock.calls[0];
    expect(userId).toBe('user-1');
    expect(row).toMatchObject({ id: result!.id, title: 'Easy run', date: '2026-09-01', type: 'cardio', is_recurring: false });
    expect(triggeredBy).toBe('ai');
    // Yesterday's workout was done, not planned: completion + plan-filled session.
    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(quickCompletePlan).toHaveBeenCalledTimes(1);
    expect(ctx.events.some(e => e.id === result!.id)).toBe(true);
  });

  it('createEvent leaves a future event and a recurring series unlogged', async () => {
    const { deps } = makeDeps();
    await deps.createEvent({ type: 'weights', title: 'Later', date: '2026-09-20', estimatedDuration: 60 });
    await deps.createEvent({ type: 'weights', title: 'Series', date: '2026-08-01', estimatedDuration: 60, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' });
    expect(recordCompletion).not.toHaveBeenCalled();
    expect(quickCompletePlan).not.toHaveBeenCalled();
  });

  it('updateEvent targets the base id with snake_case fields and an ai-attributed log', async () => {
    const { deps } = makeDeps();
    expect(await deps.updateEvent({ id: 'evt-weekly__2026-09-08', fields: { title: 'Bench (heavy)', estimatedDuration: 75 } })).toBe(true);
    const [, , id, fields, log] = vi.mocked(events.updateEvent).mock.calls[0];
    expect(id).toBe('evt-weekly');
    expect(fields).toMatchObject({ title: 'Bench (heavy)', estimated_duration: 75 });
    expect(log).toMatchObject({ event_title: 'Bench (heavy)', triggered_by: 'ai' });
  });

  it('deleteEvent answers false on a service failure, like the browser\'s catch', async () => {
    const { deps } = makeDeps();
    expect(await deps.deleteEvent('evt-nope')).toBe(false);
    expect(vi.mocked(events.deleteEvent).mock.calls[0][3]).toMatchObject({ triggered_by: 'ai' });
  });

  it('rescheduleEvent: a one-off patches the event; an occurrence writes a merged override', async () => {
    const { deps } = makeDeps();
    expect(await deps.rescheduleEvent('evt-solo', { date: '2026-09-11' })).toBe(true);
    expect(events.updateEvent).toHaveBeenCalledTimes(1);

    expect(await deps.rescheduleEvent('evt-weekly__2026-09-08', { date: '2026-09-09' })).toBe(true);
    const [, , target, overrides] = vi.mocked(instances.rescheduleInstance).mock.calls[0];
    expect(target).toMatchObject({ eventId: 'evt-weekly', date: '2026-09-08', eventTitle: 'Bench', triggeredBy: 'ai' });
    // The earlier 06:00 start survives the date-only move.
    expect(overrides).toEqual({ startTime: '06:00', date: '2026-09-09' });

    expect(await deps.rescheduleEvent('evt-missing', { date: '2026-09-09' })).toBe(false);
  });

  it('deleteEventInstance skips the occurrence with the series title', async () => {
    const { deps } = makeDeps();
    expect(await deps.deleteEventInstance('evt-weekly', '2026-09-08')).toBe(true);
    expect(vi.mocked(instances.skipInstance).mock.calls[0][2]).toEqual({ eventId: 'evt-weekly', date: '2026-09-08', eventTitle: 'Bench', triggeredBy: 'ai' });
  });

  it('createDefinition slugs the id, defaults the arrays, and resolves synchronously for the executor', async () => {
    const { deps, ctx } = makeDeps();
    const result = await deps.createDefinition({ canonicalName: 'Front Squat', category: 'strength' });
    expect(result).toEqual({ id: 'front-squat' });
    expect(vi.mocked(definitions.createDefinition).mock.calls[0][2]).toMatchObject({ id: 'front-squat', canonical_name: 'Front Squat', category: 'strength', aliases: [] });
    expect(ctx.definitions.get('front-squat')?.canonicalName).toBe('Front Squat');
  });

  it('createMeal mints a meal- id and pushes it into the executor\'s meals; deleteMeal logs the title', async () => {
    const { deps, ctx } = makeDeps();
    const result = await deps.createMeal({ title: 'Oats', date: '2026-09-03', notes: '' } as never);
    expect(result?.id).toMatch(/^meal-/);
    expect(vi.mocked(mealsSvc.createMeal).mock.calls[0][3]).toBe('ai');
    expect(ctx.meals.map(m => m.title)).toEqual(['Oats']);
    await deps.deleteMeal(result!.id);
    expect(vi.mocked(mealsSvc.deleteMeal).mock.calls[0][3]).toEqual({ meal_title: 'Oats', triggered_by: 'ai' });
  });
});
