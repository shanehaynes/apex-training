import { describe, it, expect } from 'vitest';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import {
  decodeSessionCursor,
  encodeSessionCursor,
  listSessionsTool,
  matchesSessionFilters,
  sessionCursorPredicate,
} from '../_lib/mcp/tools/sessions';
import { MCP_TOOLS } from '../_lib/mcp/toolRegistry';

// list_sessions: the cursor, the filter composition, and the tool over a
// fixture stub that applies the query — including the keyset `or` and the
// `ilike` the exercise filter leans on — so what is checked is the page the
// database would hand back, not a drained table.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Row = Record<string, unknown>;

const CURSOR_OR = /^event_date\.lt\."([^"]+)",and\(event_date\.eq\."([^"]+)",started_at\.lt\."([^"]+)"\)$/;

function makeAdmin(fixtures: Record<string, Row[]>, log: string[] = []): Admin {
  return {
    from(table: string) {
      log.push(table);
      let rows = [...(fixtures[table] ?? [])];
      let limit = Infinity;
      const builder: Record<string, unknown> = {};
      const keep = (pred: (r: Row) => boolean) => {
        rows = rows.filter(pred);
        return builder;
      };
      const str = (v: unknown) => (v == null ? '' : String(v));
      builder.select = () => builder;
      builder.eq = (c: string, v: unknown) => keep(r => r[c] === v);
      builder.in = (c: string, values: unknown[]) => keep(r => values.includes(r[c]));
      builder.ilike = (c: string, pattern: string) => {
        const m = /^%(.*)%$/.exec(pattern);
        if (!m) throw new Error(`unmocked ilike pattern ${pattern}`);
        const needle = m[1].replace(/\\([\\%_])/g, '$1').toLowerCase();
        return keep(r => str(r[c]).toLowerCase().includes(needle));
      };
      builder.or = (expr: string) => {
        const m = CURSOR_OR.exec(expr);
        if (!m) throw new Error(`unmocked or ${expr}`);
        const [, lt, eq, startedLt] = m;
        return keep(r => str(r.event_date) < lt || (str(r.event_date) === eq && str(r.started_at) < startedLt));
      };
      const orders: Array<{ c: string; asc: boolean }> = [];
      builder.order = (c: string, opts: { ascending?: boolean } = {}) => {
        orders.push({ c, asc: opts.ascending !== false });
        rows.sort((a, b) => {
          for (const o of orders) {
            const av = str(a[o.c]);
            const bv = str(b[o.c]);
            if (av !== bv) return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
          }
          return 0;
        });
        return builder;
      };
      builder.limit = (n: number) => {
        limit = n;
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve, reject);
      return builder;
    },
  } as unknown as Admin;
}

const USER = 'user-123';

const session = (id: string, date: string, startedAt: string, extra: Row = {}): Row => ({
  id,
  user_id: USER,
  event_id: `evt-${id}`,
  event_date: date,
  started_at: startedAt,
  finished_at: null,
  total_duration_seconds: null,
  coach_summary: null,
  template_id: null,
  score_type: null,
  score_time_seconds: null,
  score_rounds: null,
  score_reps: null,
  ...extra,
});

const event = (id: string, title: string, extra: Row = {}): Row => ({
  id, user_id: USER, title, type: 'weights', sport: null, tags: [], ...extra,
});

type Payload = { sessions: Array<Record<string, unknown>>; nextCursor: string | null };

async function run(admin: Admin, args: Record<string, unknown> = {}): Promise<Payload> {
  return (await listSessionsTool.run(admin, USER, args)) as Payload;
}

describe('session cursor', () => {
  it('round-trips the (event_date, started_at) keyset through an opaque string', () => {
    const cursor = { eventDate: '2026-04-06', startedAt: '2026-04-06T07:30:00.000Z' };
    const encoded = encodeSessionCursor(cursor);
    expect(encoded).not.toContain('2026-04-06');
    expect(decodeSessionCursor(encoded)).toEqual(cursor);
  });

  it('refuses a cursor it did not issue', () => {
    expect(() => decodeSessionCursor('not-base64-json')).toThrow('cursor is not a cursor this tool issued.');
    expect(() => decodeSessionCursor(Buffer.from('{"d":"yesterday","t":"x"}').toString('base64url')))
      .toThrow('cursor is not a cursor this tool issued.');
    expect(() => decodeSessionCursor(Buffer.from('[1,2]').toString('base64url')))
      .toThrow('cursor is not a cursor this tool issued.');
  });

  it('builds the strictly-after predicate with quoted values', () => {
    expect(sessionCursorPredicate({ eventDate: '2026-04-06', startedAt: '2026-04-06T07:30:00.000Z' })).toBe(
      'event_date.lt."2026-04-06",and(event_date.eq."2026-04-06",started_at.lt."2026-04-06T07:30:00.000Z")',
    );
  });
});

describe('matchesSessionFilters', () => {
  const joined = {
    title: 'Upper Body — Push',
    type: 'weights',
    sport: null,
    tags: ['Push', 'hypertrophy'],
    exerciseNames: ['Bench Press', 'Overhead Press'],
  };

  it('holds with no filters, and each filter alone, case-insensitively', () => {
    expect(matchesSessionFilters(joined, {})).toBe(true);
    expect(matchesSessionFilters(joined, { type: 'Weights' })).toBe(true);
    expect(matchesSessionFilters(joined, { tag: 'push' })).toBe(true);
    expect(matchesSessionFilters(joined, { q: 'body — p' })).toBe(true);
    expect(matchesSessionFilters(joined, { exercise: 'press' })).toBe(true);
  });

  it('rejects on the one filter that fails', () => {
    expect(matchesSessionFilters(joined, { type: 'climbing' })).toBe(false);
    expect(matchesSessionFilters(joined, { sport: 'running' })).toBe(false);
    expect(matchesSessionFilters(joined, { tag: 'legs' })).toBe(false);
    expect(matchesSessionFilters(joined, { q: 'pull' })).toBe(false);
    expect(matchesSessionFilters(joined, { exercise: 'squat' })).toBe(false);
  });

  it('combines filters with AND', () => {
    expect(matchesSessionFilters(joined, { type: 'weights', tag: 'push', q: 'upper' })).toBe(true);
    expect(matchesSessionFilters(joined, { type: 'weights', tag: 'push', q: 'lower' })).toBe(false);
  });
});

describe('list_sessions', () => {
  // Five sessions over three dates. s3 and s4 share a date — the second
  // keyset column is what separates them — and s5 is a retro-log: the newest
  // started_at on the oldest date, so a started_at-only cursor would misplace it.
  const fixtures = {
    workout_sessions: [
      session('s1', '2026-10-01', '2026-10-01T08:00:00.000Z', { coach_summary: 'Good one.', finished_at: '2026-10-01T09:00:00.000Z' }),
      session('s2', '2026-09-20', '2026-09-20T08:00:00.000Z', { total_duration_seconds: 1500 }),
      session('s3', '2026-09-10', '2026-09-10T18:00:00.000Z', { event_id: 'rec__2026-09-10', score_type: 'for-time', score_time_seconds: 540 }),
      session('s4', '2026-09-10', '2026-09-10T07:00:00.000Z'),
      session('s5', '2026-04-06', '2026-10-05T12:00:00.000Z'),
      session('s6', '2026-03-01', '2026-03-01T08:00:00.000Z'),
    ],
    workout_completions: [
      { user_id: USER, event_id: 'evt-s1', event_date: '2026-10-01', event_title: 'Push Day (done)', event_type: 'weights' },
    ],
    workout_events: [
      event('evt-s1', 'Push Day'),
      event('evt-s2', 'Easy Run', { type: 'cardio', sport: 'running', tags: ['z2'] }),
      event('rec', 'Metcon', { tags: ['conditioning'] }),
      event('evt-s4', 'Boulder Session', { type: 'climbing', sport: 'climbing' }),
      event('evt-s6', 'Leg Day'),
    ],
    workout_set_logs: [
      { user_id: USER, event_id: 'evt-s1', event_date: '2026-10-01', exercise_name: 'Bench Press' },
      { user_id: USER, event_id: 'evt-s5', event_date: '2026-04-06', exercise_name: 'Bench Press' },
      { user_id: 'someone-else', event_id: 'evt-s4', event_date: '2026-09-10', exercise_name: 'Bench Press' },
    ],
    workout_cardio_logs: [
      { user_id: USER, event_id: 'evt-s2', event_date: '2026-09-20', exercise_name: 'Easy run' },
    ],
  };

  it('lists newest first with the joined title, type, duration, summary flag and score', async () => {
    const { sessions, nextCursor } = await run(makeAdmin(fixtures));
    expect(sessions.map(s => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(nextCursor).toBeNull();
    expect(sessions[0]).toMatchObject({
      eventId: 'evt-s1', eventDate: '2026-10-01', title: 'Push Day (done)', type: 'weights', sport: null, tags: [],
      startedAt: '2026-10-01T08:00:00.000Z', finishedAt: '2026-10-01T09:00:00.000Z',
      durationSeconds: 3600, hasSummary: true, score: null,
    });
    expect(sessions[1]).toMatchObject({ title: 'Easy Run', type: 'cardio', sport: 'running', tags: ['z2'], durationSeconds: 1500, hasSummary: false });
    expect(sessions[2]).toMatchObject({
      eventId: 'rec__2026-09-10', title: 'Metcon', score: { type: 'for-time', timeSeconds: 540, rounds: null, reps: null },
      durationSeconds: null,
    });
    expect(sessions[4]).toMatchObject({ title: 'Workout', type: null });
  });

  it('pages with the cursor, and a session inserted between pages does not shift the next one', async () => {
    const page1 = await run(makeAdmin(fixtures), { limit: 2 });
    expect(page1.sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const grown = {
      ...fixtures,
      workout_sessions: [session('s0', '2026-10-12', '2026-10-12T08:00:00.000Z'), ...fixtures.workout_sessions],
    };
    const page2 = await run(makeAdmin(grown), { limit: 2, cursor: page1.nextCursor });
    expect(page2.sessions.map(s => s.id)).toEqual(['s3', 's4']);
    const page3 = await run(makeAdmin(grown), { limit: 2, cursor: page2.nextCursor });
    expect(page3.sessions.map(s => s.id)).toEqual(['s5', 's6']);
  });

  it('ends with a null cursor when the last page is exactly full', async () => {
    const page1 = await run(makeAdmin(fixtures), { limit: 3 });
    expect(page1.sessions.map(s => s.id)).toEqual(['s1', 's2', 's3']);
    const page2 = await run(makeAdmin(fixtures), { limit: 3, cursor: page1.nextCursor });
    expect(page2.sessions.map(s => s.id)).toEqual(['s4', 's5', 's6']);
    expect(page2.nextCursor).toEqual(expect.any(String));
    const after = await run(makeAdmin(fixtures), { limit: 3, cursor: page2.nextCursor });
    expect(after).toEqual({ sessions: [], nextCursor: null });
  });

  it('filters by type, sport, tag and title, with AND', async () => {
    expect((await run(makeAdmin(fixtures), { type: 'climbing' })).sessions.map(s => s.id)).toEqual(['s4']);
    expect((await run(makeAdmin(fixtures), { sport: 'running' })).sessions.map(s => s.id)).toEqual(['s2']);
    expect((await run(makeAdmin(fixtures), { tag: 'Conditioning' })).sessions.map(s => s.id)).toEqual(['s3']);
    expect((await run(makeAdmin(fixtures), { q: 'push' })).sessions.map(s => s.id)).toEqual(['s1']);
    expect((await run(makeAdmin(fixtures), { q: 'push', type: 'cardio' })).sessions).toEqual([]);
  });

  it('filters by a logged exercise name across set and cardio logs, scoped to the user', async () => {
    const log: string[] = [];
    expect((await run(makeAdmin(fixtures, log), { exercise: 'bench' })).sessions.map(s => s.id)).toEqual(['s1', 's5']);
    expect(log).toContain('workout_set_logs');
    expect((await run(makeAdmin(fixtures), { exercise: 'easy RUN' })).sessions.map(s => s.id)).toEqual(['s2']);
  });

  it('does not touch the log tables unless the exercise filter is on', async () => {
    const log: string[] = [];
    await run(makeAdmin(fixtures, log), { q: 'push' });
    expect(log).not.toContain('workout_set_logs');
    expect(log).not.toContain('workout_cardio_logs');
  });

  it('keeps a filtered page stable across cursors', async () => {
    const page1 = await run(makeAdmin(fixtures), { type: 'weights', limit: 2 });
    expect(page1.sessions.map(s => s.id)).toEqual(['s1', 's3']);
    const page2 = await run(makeAdmin(fixtures), { type: 'weights', limit: 2, cursor: page1.nextCursor });
    expect(page2.sessions.map(s => s.id)).toEqual(['s6']);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects malformed arguments', async () => {
    const admin = makeAdmin(fixtures);
    await expect(run(admin, { limit: 51 })).rejects.toThrow(/between 1 and 50/);
    await expect(run(admin, { limit: 0 })).rejects.toThrow(/between 1 and 50/);
    await expect(run(admin, { cursor: 'nope' })).rejects.toThrow('cursor is not a cursor this tool issued.');
    await expect(run(admin, { type: 7 })).rejects.toThrow('type must be a string.');
    await expect(run(admin, { q: 'x'.repeat(101) })).rejects.toThrow(/at most 100 characters/);
  });

  it('is registered among the MCP query tools, ahead of the history readers', () => {
    const names = MCP_TOOLS.map(t => t.name);
    expect(names.indexOf('list_sessions')).toBeGreaterThan(names.indexOf('get_meals'));
    expect(names.indexOf('list_sessions')).toBeLessThan(names.indexOf('get_session_summaries'));
  });
});
