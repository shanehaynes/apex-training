import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/eventInstances';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  /** The parent event row the ownership check finds (null → 404). */
  parent: { id: string; date: string } | null;
  inserted: Record<string, unknown>[];
  /** Tables the skip purged, and the ids it matched on. */
  purged: { table: string; eventIds: string[] }[];
  /** Tables the reschedule re-dated, the ids matched, and the new event_date. */
  migrated: { table: string; eventIds: string[]; eventDate: unknown }[];
  /** Tables the detach re-identified, the ids matched, and the new values. */
  relabeled: { table: string; eventIds: string[]; values: Record<string, unknown> }[];
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.parent, error: null }) }),
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          state.inserted.push({ table, ...row });
          return { error: null };
        },
        // Reschedule path, two shapes: the exception row is updated in place
        // (…eq.select), and every tracked table is re-dated (…eq.in.neq).
        update: (values: Record<string, unknown>) => {
          const node = {
            eq: () => node,
            select: async () => ({ data: [{ id: 'ex-1' }], error: null }),
            in: (_column: string, eventIds: string[]) => ({
              neq: async () => {
                state.migrated.push({ table, eventIds, eventDate: values.event_date });
                return { error: null };
              },
              // The detach relabel awaits `.in(...)` directly (no .neq) —
              // record it through the thenable instead.
              then: (resolve: (v: { error: null }) => void) => {
                state.relabeled.push({ table, eventIds, values });
                resolve({ error: null });
              },
            }),
          };
          return node;
        },
        delete: () => {
          const node = {
            eq: () => node,
            in: async (_column: string, eventIds: string[]) => {
              state.purged.push({ table, eventIds });
              return { error: null };
            },
          };
          return node;
        },
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown): VercelRequest {
  return { method: 'POST', headers: {}, body, query: {} } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  const res = {
    status(c: number) { code = c; return res; },
    send() { return res; },
    json() { return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code };
}

let state: AdminState;

beforeEach(() => {
  state = { parent: { id: 'evt-1', date: '2026-07-06' }, inserted: [], purged: [], migrated: [], relabeled: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

const purgedIds = () => state.purged.map(p => [...p.eventIds].sort());
const migratedIds = () => state.migrated.map(m => [...m.eventIds].sort());
const TRACKED_TABLES = [
  'activity_streams',
  'workout_cardio_logs',
  'workout_completions',
  'workout_sessions',
  'workout_set_logs',
];

describe('POST /api/event-instances — deleting one occurrence', () => {
  it('purges the occurrence id for a later date in the series', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ eventId: 'evt-1', date: '2026-07-13', triggeredBy: 'user' }), res);

    expect(statusCode()).toBe(200);
    expect(state.purged.map(p => p.table).sort()).toEqual([
      'activity_streams',
      'workout_cardio_logs',
      'workout_completions',
      'workout_sessions',
      'workout_set_logs',
    ]);
    // Only the expanded id: the bare base id belongs to the series anchor,
    // whose logs are a different day's session.
    expect(purgedIds().every(ids => ids.length === 1 && ids[0] === 'evt-1__2026-07-13')).toBe(true);
  });

  it('also purges the bare base id when the skipped day is the series anchor', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ eventId: 'evt-1', date: '2026-07-06', triggeredBy: 'user' }), res);

    expect(statusCode()).toBe(200);
    // The anchor occurrence keeps the base id through expansion, so its logs
    // may sit under either form.
    expect(purgedIds().every(ids => ids.join() === 'evt-1,evt-1__2026-07-06')).toBe(true);
  });

  it('purges nothing for an event the caller does not own', async () => {
    state.parent = null;
    const { res, statusCode } = makeRes();
    await handler(makeReq({ eventId: 'someone-elses', date: '2026-07-13', triggeredBy: 'user' }), res);

    expect(statusCode()).toBe(404);
    expect(state.purged).toEqual([]);
  });

  it('purges nothing when the occurrence is only rescheduled', async () => {
    const { res, statusCode } = makeRes();
    await handler(
      makeReq({ eventId: 'evt-1', date: '2026-07-13', overrides: { date: '2026-07-14' }, triggeredBy: 'user' }),
      res,
    );

    expect(statusCode()).toBe(200);
    expect(state.purged, 'a moved workout still happened').toEqual([]);
  });
});

describe('POST /api/event-instances — rescheduling one occurrence', () => {
  it('re-dates every tracked table to the new day', async () => {
    const { res, statusCode } = makeRes();
    await handler(
      makeReq({ eventId: 'evt-1', date: '2026-07-13', overrides: { date: '2026-07-14' }, triggeredBy: 'user' }),
      res,
    );

    expect(statusCode()).toBe(200);
    expect(state.migrated.map(m => m.table).sort()).toEqual(TRACKED_TABLES);
    // The id stays pinned to the ORIGINAL date — only event_date moves.
    expect(migratedIds().every(ids => ids.length === 1 && ids[0] === 'evt-1__2026-07-13')).toBe(true);
    expect(state.migrated.every(m => m.eventDate === '2026-07-14')).toBe(true);
  });

  it('also re-dates the bare base id when the moved day is the series anchor', async () => {
    const { res, statusCode } = makeRes();
    await handler(
      makeReq({ eventId: 'evt-1', date: '2026-07-06', overrides: { date: '2026-07-07' }, triggeredBy: 'user' }),
      res,
    );

    expect(statusCode()).toBe(200);
    expect(migratedIds().every(ids => ids.join() === 'evt-1,evt-1__2026-07-06')).toBe(true);
  });

  it('re-dates to the occurrence date when only the time changed', async () => {
    const { res, statusCode } = makeRes();
    await handler(
      makeReq({ eventId: 'evt-1', date: '2026-07-13', overrides: { startTime: '18:00' }, triggeredBy: 'user' }),
      res,
    );

    expect(statusCode()).toBe(200);
    // A time-only override clears override_date, so the occurrence falls back
    // to its own date — and any logs stranded by an earlier move come with it.
    expect(state.migrated.every(m => m.eventDate === '2026-07-13')).toBe(true);
  });

  it('re-dates nothing for an event the caller does not own', async () => {
    state.parent = null;
    const { res, statusCode } = makeRes();
    await handler(
      makeReq({ eventId: 'someone-elses', date: '2026-07-13', overrides: { date: '2026-07-14' }, triggeredBy: 'user' }),
      res,
    );

    expect(statusCode()).toBe(404);
    expect(state.migrated).toEqual([]);
  });
});

describe('POST /api/event-instances — detaching one occurrence', () => {
  const DETACH_EVENT = {
    id: 'ai-fresh',
    type: 'weights',
    title: 'Detached Day',
    date: '2026-07-13',
    estimated_duration: 60,
    difficulty: 3,
    description: '',
    warmup: [],
    exercises: [],
    cooldown: [],
    tags: [],
    equipment: [],
    is_recurring: false,
    recurrence_rule: null,
  };

  it('inserts a never-recurring standalone row and relabels the occurrence logs', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'detach', eventId: 'evt-1', date: '2026-07-13', triggeredBy: 'user',
      event: { ...DETACH_EVENT, is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' },
    }), res);

    expect(statusCode()).toBe(200);
    const inserted = state.inserted.find(r => r.table === 'workout_events')!;
    expect(inserted.id).toBe('ai-fresh');
    expect(inserted.user_id).toBe('user-123');
    // Whatever the client sent, a detached day never recurs.
    expect(inserted.is_recurring).toBe(false);
    expect(inserted.recurrence_rule).toBeNull();

    expect(state.relabeled.map(r => r.table).sort()).toEqual(TRACKED_TABLES);
    for (const r of state.relabeled) {
      expect([...r.eventIds].sort()).toEqual(['evt-1__2026-07-13']);
      expect(r.values.event_id).toBe('ai-fresh');
      expect(r.values.event_date).toBe('2026-07-13');
    }
  });

  it('also relabels the bare base id when detaching the series anchor', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'detach', eventId: 'evt-1', date: '2026-07-06', triggeredBy: 'user',
      event: { ...DETACH_EVENT, date: '2026-07-06' },
    }), res);

    expect(statusCode()).toBe(200);
    for (const r of state.relabeled) {
      expect([...r.eventIds].sort()).toEqual(['evt-1', 'evt-1__2026-07-06']);
    }
  });

  it('rejects an id carrying the occurrence separator', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'detach', eventId: 'evt-1', date: '2026-07-13', triggeredBy: 'user',
      event: { ...DETACH_EVENT, id: 'ai-fresh__2026-07-13' },
    }), res);

    expect(statusCode()).toBe(400);
    expect(state.inserted).toEqual([]);
    expect(state.relabeled).toEqual([]);
  });

  it('rejects unknown event fields loudly', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'detach', eventId: 'evt-1', date: '2026-07-13', triggeredBy: 'user',
      event: { ...DETACH_EVENT, is_template_source: true },
    }), res);

    expect(statusCode()).toBe(400);
    expect(state.inserted).toEqual([]);
  });

  it('detaches nothing for an event the caller does not own', async () => {
    state.parent = null;
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'detach', eventId: 'someone-elses', date: '2026-07-13', triggeredBy: 'user',
      event: DETACH_EVENT,
    }), res);

    expect(statusCode()).toBe(404);
    expect(state.inserted).toEqual([]);
    expect(state.relabeled).toEqual([]);
  });
});
