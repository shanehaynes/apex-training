import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { MAX_WINDOW_DAYS } from '../_lib/handlers/schedule';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../_lib/mcp/data';
import type { WorkoutEvent } from '../../src/types/workout';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/mcp/data.js', () => ({
  fetchExpandedSchedule: vi.fn(),
  fetchCompletionsInRange: vi.fn(async () => []),
}));
vi.mock('../_lib/pagination.js', () => ({
  fetchAllPages: vi.fn(async () => [{
    id: 'tpl-1', user_id: 'user-123', title: 'Push Day', type: 'weights', sport: null, tags: [],
    description: '', estimated_duration: 60, difficulty: 3, warmup: null, exercises: [], cooldown: null,
    location: null, equipment: null, scoring_type: 'strength', time_cap_minutes: null,
    archived_at: null, created_at: 'x', updated_at: 'x',
  }]),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedExpanded = vi.mocked(fetchExpandedSchedule);
const mockedCompletions = vi.mocked(fetchCompletionsInRange);

function makeReq(query: Record<string, string>, method = 'GET'): VercelRequest {
  return { method, headers: {}, query, body: undefined } as unknown as VercelRequest;
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
  return { res, statusCode: () => code, body: () => payload };
}

const base: WorkoutEvent = {
  id: 'evt-weekly', type: 'weights', title: 'Bench', date: '2026-09-01', startTime: '17:30',
  estimatedDuration: 60, description: '', exercises: [{ id: 'x1', name: 'Bench Press', category: 'strength', sets: 3 }],
  difficulty: 3, tags: [], isCompleted: false, isRecurring: true, recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
};

beforeEach(() => {
  mockedAdmin.mockReturnValue({ from: () => ({}) } as unknown as ReturnType<typeof getSupabaseAdmin>);
  mockedExpanded.mockResolvedValue({
    occurrences: [
      base,
      { ...base, id: 'evt-weekly__2026-09-08', date: '2026-09-08' },
      { ...base, id: 'evt-weekly__2026-09-15', date: '2026-09-15', startTime: '06:00' },
      { ...base, id: 'evt-weekly__2026-10-06', date: '2026-10-06' },
      { ...base, id: 'evt-solo', title: 'Long run', date: '2026-09-10', isRecurring: false, recurrenceRule: undefined },
    ],
    definitions: new Map([['def-1', { id: 'def-1', canonicalName: 'Bench Press', aliases: [], category: 'strength', muscleGroups: [], equipment: [], isUnilateral: false }]]),
  } as never);
  mockedCompletions.mockResolvedValue([
    { event_id: 'evt-weekly__2026-09-08', event_date: '2026-09-08', is_completed: true, completed_at: '2026-09-08T18:30:00Z' },
    { event_id: 'evt-solo', event_date: '2026-09-10', is_completed: false, completed_at: null },
  ] as never);
});

describe('GET /api/schedule — validation', () => {
  it('405s non-GET', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ start: '2026-09-01', end: '2026-09-30' }, 'POST'), res);
    expect(statusCode()).toBe(405);
  });

  it('400s on missing or malformed dates, reversed ranges, and oversize windows', async () => {
    const cases: Record<string, string>[] = [
      {}, { start: '2026-09-01' }, { start: '09/01/2026', end: '2026-09-30' },
      { start: '2026-09-30', end: '2026-09-01' },
      { start: '2026-01-01', end: '2027-03-01' },
    ];
    for (const q of cases) {
      const { res, statusCode } = makeRes();
      await handler(makeReq(q), res);
      expect(statusCode(), JSON.stringify(q)).toBe(400);
    }
    expect(MAX_WINDOW_DAYS).toBe(400);
  });

  it('400s on an unknown include before touching the database', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ start: '2026-09-01', end: '2026-09-30', include: 'definitions,meals' }), res);
    expect(statusCode()).toBe(400);
    expect(mockedExpanded).not.toHaveBeenCalled();
  });
});

describe('GET /api/schedule — shape', () => {
  it('returns each base once and one stub per in-window occurrence, joined to completions', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ start: '2026-09-01', end: '2026-09-30' }), res);
    expect(statusCode()).toBe(200);
    const out = body() as { window: unknown; bases: WorkoutEvent[]; occurrences: Array<Record<string, unknown>>; definitions?: unknown; templates?: unknown };

    expect(out.window).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(out.bases.map(b => b.id).sort()).toEqual(['evt-solo', 'evt-weekly']);
    // The base carries the resolved prescription; per-occurrence state is stripped.
    const weekly = out.bases.find(b => b.id === 'evt-weekly')!;
    expect(weekly.exercises[0].name).toBe('Bench Press');
    expect(weekly.isCompleted).toBe(false);

    // The October occurrence is outside the window.
    expect(out.occurrences.map(o => o.id)).toEqual([
      'evt-weekly', 'evt-weekly__2026-09-08', 'evt-weekly__2026-09-15', 'evt-solo',
    ]);
    const done = out.occurrences.find(o => o.id === 'evt-weekly__2026-09-08')!;
    expect(done).toMatchObject({ baseId: 'evt-weekly', date: '2026-09-08', isCompleted: true, completedAt: '2026-09-08T18:30:00Z', startTime: '17:30' });
    // A moved occurrence keeps its own time on the stub.
    expect(out.occurrences.find(o => o.id === 'evt-weekly__2026-09-15')!.startTime).toBe('06:00');
    // An explicit is_completed=false row is not a completion.
    expect(out.occurrences.find(o => o.id === 'evt-solo')).toMatchObject({ isCompleted: false, completedAt: null });

    expect(out.definitions).toBeUndefined();
    expect(out.templates).toBeUndefined();
    // Horizon anchored at the window end so the expander covers it.
    expect(mockedExpanded).toHaveBeenCalledWith(expect.anything(), 'user-123', '2026-09-30');
  });

  it('attaches definitions and mapped templates when asked', async () => {
    const { res, body } = makeRes();
    await handler(makeReq({ start: '2026-09-01', end: '2026-09-30', include: 'definitions, templates' }), res);
    const out = body() as { definitions: Array<{ canonicalName: string }>; templates: Array<{ id: string; title: string }> };
    expect(out.definitions.map(d => d.canonicalName)).toEqual(['Bench Press']);
    expect(out.templates).toEqual([expect.objectContaining({ id: 'tpl-1', title: 'Push Day' })]);
  });
});
