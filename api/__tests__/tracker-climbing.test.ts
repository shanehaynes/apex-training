import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildBootstrap, buildFinishSummary, checkSwapShape } from '../_lib/trackerSession';
import handler from '../_lib/handlers/workoutSessions';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import type { SetLogRow, WorkoutSessionRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'u1') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/trackerSession.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/trackerSession.js')>()),
  // The occurrence is scripted; the shape check itself runs for real.
  loadResolvedOccurrence: vi.fn(async () => EVENT),
}));

type Admin = Parameters<typeof buildFinishSummary>[0];

// Climbing, server side: the send record is detected at Finish (and on
// reopening a finished session) from the saved rows against full history,
// added pitches included; and swap-exercise refuses to turn a pitch into a
// lift or a lift into a pitch.

interface Updates { table: string; patch: Record<string, unknown> }

/** A chainable fake applying eq / lt / in filters; records updates. */
function makeAdmin(fixtures: Record<string, Record<string, unknown>[]>, updates: Updates[] = []): Admin {
  return {
    from(table: string) {
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      const rows = () => (fixtures[table] ?? []).filter(row => filters.every(f => f(row)));
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'range', 'not', 'is', 'gte', 'lte']) builder[m] = chain;
      builder.eq = (column: string, value: unknown) => {
        filters.push(row => column === 'user_id' || row[column] === value);
        return builder;
      };
      builder.lt = (column: string, value: string) => {
        filters.push(row => String(row[column]) < value);
        return builder;
      };
      builder.in = (column: string, values: unknown[]) => {
        filters.push(row => values.includes(row[column]));
        return builder;
      };
      builder.update = (patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
      return builder;
    },
  } as unknown as Admin;
}

const EVENT = {
  id: 'climb-1', date: '2026-09-20', title: 'Crag day', type: 'outdoor-climbing', estimatedDuration: 240,
  description: '', difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  exercises: [
    { id: 'p1', name: 'Sport', category: 'climbing', climbStyle: 'sport', grade: '5.11a' },
    { id: 'bench', name: 'Bench Press', category: 'strength', sets: 1, reps: '5' },
  ],
} as unknown as WorkoutEvent;

function pitch(over: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'climb-1', event_date: '2026-09-20', section: 'exercise', exercise_id: 'p1', exercise_name: 'Sport',
    set_number: 1, planned_weight: '5.11a', planned_reps: null, planned_duration: null,
    actual_weight: '5.11a', actual_reps: null, actual_duration: null,
    is_autofilled: false, is_warmup: false, ascent_style: 'redpoint', attempts: 3, definition_id: null,
    ...over,
  } as SetLogRow;
}

const DEFINITIONS = [
  { id: 'def-lead', canonical_name: 'Lead', aliases: [], category: 'climbing' },
  { id: 'def-bench', canonical_name: 'Bench Press', aliases: [], category: 'strength' },
  { id: 'def-stretch', canonical_name: 'Pigeon', aliases: [], category: 'stretch' },
];

describe('send records at Finish', () => {
  const fixtures = () => ({
    profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }],
    exercise_definitions: DEFINITIONS,
    workout_set_logs: [
      // Earlier: a planned pitch redpointed at 5.10b, and an added Lead pitch at 5.9.
      pitch({ event_id: 'climb-0', event_date: '2026-09-01', actual_weight: '5.10b' }),
      pitch({ event_id: 'climb-0', event_date: '2026-09-01', exercise_id: 'added-1', exercise_name: 'Lead', definition_id: 'def-lead', actual_weight: '5.9', ascent_style: 'flash', attempts: 1 }),
      // Today: the planned pitch at 5.11a, and a Lead pitch added mid-session.
      pitch({}),
      pitch({ exercise_id: 'added-2', exercise_name: 'Lead', definition_id: 'def-lead', planned_weight: null, actual_weight: '5.10a', ascent_style: 'flash', attempts: 1 }),
    ] as unknown as Record<string, unknown>[],
  });

  it('a harder clean send is a send record, planned and added pitches alike', async () => {
    const summary = await buildFinishSummary(makeAdmin(fixtures()), 'u1', EVENT, 3600, null);
    expect(summary.prs).toEqual([
      expect.objectContaining({ kind: 'send', exerciseName: 'Sport', grade: '5.11a', discipline: 'sport', style: 'redpoint', previousGrade: '5.10b', previousDate: '2026-09-01', description: 'Redpointed 5.11a, up from 5.10b on Sep 1' }),
      expect.objectContaining({ kind: 'send', exerciseName: 'Lead', grade: '5.10a', style: 'flash', previousGrade: '5.9' }),
    ]);
    // The added pitch came back a pitch: its grade was never read as a weight.
    const added = summary.groups[0].exercises.find(t => t.exercise.id === 'added-2')!;
    expect(added.exercise.category).toBe('climbing');
    expect(added.sets[0]).toMatchObject({ actualWeight: '5.10a', ascentStyle: 'flash', attempts: '1' });
  });

  it("reopening the finished session's summary reports the same records", async () => {
    const admin = makeAdmin(fixtures());
    const finished = { finished_at: '2026-09-20T18:00:00.000Z', started_at: '2026-09-20T09:00:00.000Z' } as WorkoutSessionRow;
    const [boot, finish] = await Promise.all([
      buildBootstrap(admin, 'u1', finished, EVENT),
      buildFinishSummary(admin, 'u1', EVENT, 3600, null),
    ]);
    expect(boot.prs).toHaveLength(2);
    expect(boot.prs).toEqual(finish.prs);
  });

  it('an attempt at a harder grade is no record', async () => {
    const f = fixtures();
    f.workout_set_logs[2] = pitch({ actual_weight: '5.12a', ascent_style: 'attempt' }) as unknown as Record<string, unknown>;
    const summary = await buildFinishSummary(makeAdmin(f), 'u1', EVENT, 3600, null);
    expect(summary.prs.filter(pr => pr.exerciseName === 'Sport')).toEqual([]);
  });
});

describe('checkSwapShape', () => {
  const target = (exerciseId: string) => ({ eventId: 'climb-1', eventDate: '2026-09-20', section: 'exercise' as const, exerciseId });
  const admin = () => makeAdmin({
    exercise_definitions: DEFINITIONS,
    workout_set_logs: [
      pitch({ exercise_id: 'added-2', exercise_name: 'Lead', definition_id: 'def-lead' }),
      pitch({ exercise_id: 'added-3', exercise_name: 'Push-Up', definition_id: null, ascent_style: null, attempts: null, actual_weight: null, actual_reps: '20' }),
    ] as unknown as Record<string, unknown>[],
  });

  it('refuses a pitch relabelled as a lift, and a lift relabelled as a pitch', async () => {
    const pitchToLift = await checkSwapShape(admin(), 'u1', EVENT, target('p1'), 'def-bench');
    expect(pitchToLift).toMatchObject({ ok: false, status: 400 });
    if (!pitchToLift.ok) expect(pitchToLift.message).toContain('climbing');
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('bench'), 'def-lead')).toMatchObject({ ok: false, status: 400 });
    // An added pitch is known by its rows.
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('added-2'), 'def-bench')).toMatchObject({ ok: false, status: 400 });
  });

  it('allows a swap that keeps the shape', async () => {
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('p1'), 'def-lead')).toMatchObject({ ok: true });
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('bench'), 'def-stretch')).toMatchObject({ ok: true });
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('added-3'), 'def-bench')).toMatchObject({ ok: true });
  });

  it('refuses a definition the caller does not have; a free-text swap has nothing to compare', async () => {
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('p1'), 'def-nope')).toMatchObject({ ok: false, status: 400 });
    expect(await checkSwapShape(admin(), 'u1', EVENT, target('p1'), null)).toMatchObject({ ok: true });
  });
});

describe('POST /api/workout-sessions swap-exercise refuses a category change', () => {
  let updates: Updates[];
  beforeEach(() => {
    updates = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin({ exercise_definitions: DEFINITIONS }, updates) as never);
  });

  function call(body: unknown) {
    let code: number | null = null;
    let payload: unknown;
    const res = {
      status(c: number) { code = c; return res; },
      send(b: unknown) { payload = b; return res; },
      json(b: unknown) { payload = b; return res; },
      setHeader() { return res; },
    } as unknown as VercelResponse;
    return handler({ method: 'POST', headers: {}, query: {}, body } as unknown as VercelRequest, res)
      .then(() => ({ code, payload }));
  }
  const swap = { action: 'swap-exercise', eventId: 'climb-1', eventDate: '2026-09-20', section: 'exercise', exerciseId: 'p1' };

  it('400s a pitch swapped onto a lift and relabels nothing', async () => {
    const { code } = await call({ ...swap, exerciseName: 'Bench Press', definitionId: 'def-bench' });
    expect(code).toBe(400);
    expect(updates).toEqual([]);
  });

  it('relabels a pitch swapped onto another pitch', async () => {
    const { code } = await call({ ...swap, exerciseName: 'Lead', definitionId: 'def-lead' });
    expect(code).toBe(200);
    expect(updates.map(u => u.table).sort()).toEqual(['workout_cardio_logs', 'workout_set_logs']);
  });
});
