import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachTool';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceAiMutationCap } from '../_lib/rateLimit';
import { createServerDeps } from '../_lib/coach/serverDeps';
import { emptyDraft } from '../../src/lib/builder/draft';
import { emptyChartDraft } from '../../src/lib/analytics/draft';
import type { CoachToolDeps } from '../../src/lib/coach/tools';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));
vi.mock('../_lib/mcp/data.js', () => ({
  fetchExpandedSchedule: vi.fn(async () => ({
    occurrences: [{ id: 'evt-9', title: 'Leg day', date: '2026-09-04', type: 'weights', estimatedDuration: 60, isCompleted: false, isRecurring: false, exercises: [], tags: [], description: '', difficulty: 3 }],
    definitions: new Map(),
  })),
}));
vi.mock('../_lib/trackerSession.js', () => ({
  loadMealsForDate: vi.fn(async () => [{ id: 'meal-today', title: 'Oats', date: '2026-09-03', fatTotalG: 10 }]),
}));
vi.mock('../_lib/coach/serverDeps.js', () => ({ createServerDeps: vi.fn() }));

const deps = {
  definitions: new Map(), meals: [],
  createEvent: vi.fn(async () => ({ id: 'ai-1' })),
  updateEvent: vi.fn(async () => true),
  deleteEvent: vi.fn(async () => true),
  deleteEventInstance: vi.fn(async () => true),
  rescheduleEvent: vi.fn(async () => true),
  createDefinition: vi.fn(async () => ({ id: 'd' })),
  updateDefinition: vi.fn(async () => true),
  createMeal: vi.fn(async () => ({ id: 'm' })),
  updateMeal: vi.fn(async () => true),
  deleteMeal: vi.fn(async () => true),
} satisfies CoachToolDeps;

let mealLookups: string[];
function makeAdmin() {
  const chain = {
    select: () => chain, eq: (_c: string, v: string) => { if (typeof v === 'string' && v.startsWith('meal-')) mealLookups.push(v); return chain; },
    maybeSingle: async () => ({ data: { id: 'meal-old', title: 'Dinner', date: '2026-09-01', protein_g: 30, fat_total_g: 20, fat_saturated_g: 5, fat_trans_g: 0, notes: '' }, error: null }),
  };
  return { from: () => chain } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown, method = 'POST'): VercelRequest {
  return { method, headers: {}, query: {}, body } as unknown as VercelRequest;
}
function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload as Record<string, unknown> };
}

beforeEach(() => {
  mealLookups = [];
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  vi.mocked(createServerDeps).mockClear();
  vi.mocked(createServerDeps).mockReturnValue(deps);
  vi.mocked(enforceAiMutationCap).mockClear();
  vi.mocked(enforceAiMutationCap).mockResolvedValue(true);
  for (const fn of Object.values(deps)) if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
});

describe('POST /api/coach-tool — validation', () => {
  it('405s non-POST; 400s unknown tools, non-object input, bad today', async () => {
    const a = makeRes();
    await handler(makeReq({ name: 'delete_event', today: '2026-09-03' }, 'GET'), a.res);
    expect(a.statusCode()).toBe(405);
    for (const body of [
      { name: 'drop_table', today: '2026-09-03' },
      { name: 'delete_event', input: 'x', today: '2026-09-03' },
      { name: 'delete_event', input: {}, today: 'tomorrow' },
      { name: 'delete_event', input: {} },
    ]) {
      const { res, statusCode } = makeRes();
      await handler(makeReq(body), res);
      expect(statusCode(), JSON.stringify(body)).toBe(400);
    }
    expect(createServerDeps).not.toHaveBeenCalled();
  });
});

describe('POST /api/coach-tool — mutation tools', () => {
  it('executes the real executor over the server deps and returns its tool_result text', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ toolUseId: 'tu_1', name: 'delete_event', input: { event_id: 'evt-9', scope: 'all' }, today: '2026-09-03' }), res);
    expect(statusCode()).toBe(200);
    expect(deps.deleteEvent).toHaveBeenCalledWith('evt-9');
    expect(body().ok).toBe(true);
    expect(typeof body().resultText).toBe('string');
    expect((body().resultText as string).length).toBeGreaterThan(0);
    // The deps see the caller's schedule and today's meals.
    const ctx = vi.mocked(createServerDeps).mock.calls.at(-1)![2];
    expect(ctx.today).toBe('2026-09-03');
    expect(ctx.events.map(e => e.id)).toEqual(['evt-9']);
    expect(ctx.meals.map(m => m.id)).toEqual(['meal-today']);
  });

  it('fetches the meal an update_meal call names when it is not one of today\'s', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ name: 'update_meal', input: { meal_id: 'meal-old', changes: { protein_g: 35 } }, today: '2026-09-03' }), res);
    expect(statusCode()).toBe(200);
    expect(mealLookups).toContain('meal-old');
    const ctx = vi.mocked(createServerDeps).mock.calls.at(-1)![2];
    expect(ctx.meals.map(m => m.id)).toEqual(['meal-today', 'meal-old']);
    // Whether the executor then accepts the change is tools.ts's contract
    // (covered by its own tests); the handler's job was to hand it the row.
  });

  it('stops at the daily AI cap before loading anything or executing', async () => {
    vi.mocked(enforceAiMutationCap).mockResolvedValueOnce(false);
    const { res } = makeRes();
    await handler(makeReq({ name: 'delete_event', input: { event_id: 'evt-9', scope: 'all' }, today: '2026-09-03' }), res);
    expect(createServerDeps).not.toHaveBeenCalled();
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/coach-tool — draft tools (stateless reduce)', () => {
  it('reduces a workout draft with the real reducer and returns the next draft', async () => {
    const draft = emptyDraft('2026-09-05');
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ name: 'update_workout_draft', input: { title: 'Push Day', estimated_duration: 45 }, today: '2026-09-03', draft }), res);
    expect(statusCode()).toBe(200);
    expect(body().ok).toBe(true);
    expect((body().draft as { title: string }).title).toBe('Push Day');
    expect(typeof body().resultText).toBe('string');
    expect(enforceAiMutationCap).not.toHaveBeenCalled();
  });

  it('reduces a chart draft, and 400s when the draft is missing', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ name: 'update_chart_draft', input: { title: 'Weekly tonnage' }, today: '2026-09-03', draft: emptyChartDraft() }), res);
    expect(statusCode()).toBe(200);
    expect((body().draft as { title: string }).title).toBe('Weekly tonnage');

    const missing = makeRes();
    await handler(makeReq({ name: 'update_chart_draft', input: { title: 'x' }, today: '2026-09-03' }), missing.res);
    expect(missing.statusCode()).toBe(400);
  });
});
