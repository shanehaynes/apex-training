import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { resolveStartDate } from '../_lib/handlers/templateCopy';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
// The source account is normally resolved from the env; pinning it here keeps
// the fake admin down to the tables the copy itself touches.
vi.mock('../_lib/env.js', () => ({ optionalEnv: vi.fn(() => 'source-1') }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);

interface AdminState {
  /** Rows the lock UPDATE reports as claimed — [] means somebody else holds it. */
  lockRows: Array<{ id: string }>;
  /** What the readback sees on the profile when the claim loses. */
  copiedAt: string | null;
  /** No profiles row at all — the other reason the lock UPDATE matches nothing. */
  profileMissing?: boolean;
  sourceEvents: Array<Record<string, unknown>>;
  /** Recorded: every profiles UPDATE payload, in order. */
  profileUpdates: Array<Record<string, unknown>>;
  insertedEvents: number;
  /** Recorded: the rows of the last workout_events insert. */
  insertedRows: Array<Record<string, unknown>>;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
      const settle = (): { data: unknown; error: null } => {
        if (table === 'profiles') {
          if (op === 'update') return { data: state.lockRows, error: null };
          return { data: state.profileMissing ? null : { template_copied_at: state.copiedAt }, error: null };
        }
        if (table === 'workout_events') {
          if (op === 'insert') return { data: null, error: null };
          return { data: state.sourceEvents, error: null };
        }
        return { data: [], error: null };
      };
      for (const m of ['eq', 'is', 'in', 'or', 'limit', 'order']) b[m] = () => b;
      b.select = () => b;
      b.update = (row: Record<string, unknown>) => {
        op = 'update';
        if (table === 'profiles') state.profileUpdates.push(row);
        return b;
      };
      b.insert = (rows: unknown[]) => {
        op = 'insert';
        if (table === 'workout_events') {
          state.insertedEvents += rows.length;
          state.insertedRows = rows as Array<Record<string, unknown>>;
        }
        return b;
      };
      b.upsert = () => { op = 'upsert'; return b; };
      b.maybeSingle = async () => settle();
      b.single = async () => settle();
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown = {}): VercelRequest {
  return { method: 'POST', headers: {}, body, query: {} } as unknown as VercelRequest;
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

let state: AdminState;

beforeEach(() => {
  state = { lockRows: [{ id: 'user-123' }], copiedAt: null, sourceEvents: [], profileUpdates: [], insertedEvents: 0, insertedRows: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
});

describe('POST /api/template-copy — throttle', () => {
  it('charges the reads bucket', async () => {
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(mockedLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
  });

  it('never claims the lock when the caller is over the limit', async () => {
    mockedLimit.mockResolvedValue(false);
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(state.profileUpdates).toEqual([]);
  });
});

describe('POST /api/template-copy — a lost claim', () => {
  it('copies when it wins the claim', async () => {
    state.sourceEvents = [{
      id: 'src-1', user_id: 'source-1', title: 'Push day', date: '2026-07-06',
      is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260927',
    }];
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ events: 1, definitions: 0 });
    expect(state.insertedEvents).toBe(1);
  });

  // The claim is stamped BEFORE the inserts, so a racing caller that loses it
  // cannot conclude the plan is on the calendar — it gets the stamp instead
  // and decides for itself (a fresh one means a copy still in flight).
  it('answers with the stamp it lost to, not a bare alreadyCopied', async () => {
    state.lockRows = [];
    state.copiedAt = '2026-09-19T12:00:00Z';
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ alreadyCopied: true, copiedAt: '2026-09-19T12:00:00Z' });
    expect(state.insertedEvents).toBe(0);
  });

  // A copy that failed releases the claim, so a caller can lose the race and
  // still find nothing copied. A null stamp is how it learns that.
  it('reports a null stamp when the claim was released underneath it', async () => {
    state.lockRows = [];
    state.copiedAt = null;
    const { res, statusCode, body } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ alreadyCopied: true, copiedAt: null });
  });

  it('404s when there is no profile row to claim', async () => {
    state.lockRows = [];
    state.profileMissing = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq(), res);
    expect(statusCode()).toBe(404);
  });
});

describe('POST /api/template-copy — the 4-week block', () => {
  it('rebases each series onto the block starting on the sent date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    state.sourceEvents = [
      { id: 'src-1', user_id: 'source-1', date: '2026-07-06', is_recurring: true,
        recurrence_rule: 'FREQ=DAILY;UNTIL=20260927' },
      // 'custom' legacy pattern — nothing the engine can rebase, so skipped.
      { id: 'src-2', user_id: 'source-1', date: '2026-07-06', is_recurring: true,
        recurrence_rule: null, recurring_frequency: 'custom' },
    ];
    const { res, body } = makeRes();
    await handler(makeReq({ startDate: today }), res);
    const [y, m, d] = today.split('-').map(Number);
    const end = new Date(Date.UTC(y, m - 1, d + 27)).toISOString().slice(0, 10);
    expect(body()).toEqual({ events: 1, definitions: 0, startDate: today, endDate: end });
    expect(state.insertedRows[0]).toMatchObject({
      date: today,
      recurrence_rule: `FREQ=DAILY;UNTIL=${end.replace(/-/g, '')}`,
      recurring_end_date: end,
      user_id: 'user-123',
    });
  });
});

describe('resolveStartDate', () => {
  it('takes a date within a day of UTC today', () => {
    expect(resolveStartDate({ startDate: '2026-10-11' }, '2026-10-12')).toBe('2026-10-11');
    expect(resolveStartDate({ startDate: '2026-10-13' }, '2026-10-12')).toBe('2026-10-13');
  });

  it('falls back to UTC today for missing, malformed or far-off dates', () => {
    expect(resolveStartDate({}, '2026-10-12')).toBe('2026-10-12');
    expect(resolveStartDate(null, '2026-10-12')).toBe('2026-10-12');
    expect(resolveStartDate({ startDate: 'tomorrow' }, '2026-10-12')).toBe('2026-10-12');
    expect(resolveStartDate({ startDate: '2026-07-06' }, '2026-10-12')).toBe('2026-10-12');
  });
});
