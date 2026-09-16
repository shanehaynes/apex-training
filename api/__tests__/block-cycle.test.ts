import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/blockCycle';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';
import { generateCycle, type CycleSpec } from '../../src/lib/blocks/cadence';
import { blockToRow } from '../../src/lib/blocks/mapping';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

// The preview reads the caller's blocks for the overlap check and nothing
// else; the fake answers that one select and records that no write happened.
function makeAdmin(existing: Record<string, unknown>[], state: { wrote?: boolean } = {}) {
  return {
    from(table: string) {
      if (table !== 'training_blocks') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: existing, error: null }),
          }),
        }),
        insert: () => { state.wrote = true; throw new Error('the preview must not write'); },
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown): VercelRequest {
  return { method, headers: {}, query: { resource: 'cycle' }, body, cookies: {} } as unknown as VercelRequest;
}

function makeRes() {
  const captured: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
    send(body: unknown) { captured.body = body; return res; },
    end: () => res,
  } as unknown as VercelResponse;
  return { res, captured };
}

const spec: CycleSpec = {
  startDate: '2027-01-06',   // a Wednesday — snaps to Monday 2027-01-04
  weeksOn: 3,
  weeksOff: 1,
  cycles: 4,
  namePrefix: 'Spring',
  intent: 'Base miles',
  weeklyTargets: { cardioMinutes: 300, strengthSessions: 2 },
  recoveryScale: 0.5,
};

const existingRow = (id: string, name: string, start: string, end: string) => ({
  id, user_id: 'user-123', name, intent: '', phase: 'base', objective_id: null,
  start_date: start, end_date_exclusive: end, weekly_targets: {},
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  vi.mocked(enforceRateLimit).mockClear();
});

describe('POST /api/blocks?resource=cycle — the cycle preview', () => {
  it('405s anything but POST', async () => {
    mockedAdmin.mockReturnValue(makeAdmin([]));
    const { res, captured } = makeRes();
    await handler(makeReq('GET'), res);
    expect(captured.statusCode).toBe(405);
  });

  it('400s a body that is not a spec, before auth', async () => {
    mockedAdmin.mockReturnValue(makeAdmin([]));
    for (const [body, message] of [
      [{}, 'spec must be an object'],
      [{ spec: { ...spec, startDate: 'Jan 4' } }, 'spec.startDate must be a YYYY-MM-DD date'],
      [{ spec: { ...spec, weeksOn: '3' } }, 'spec.weeksOn must be a number'],
      [{ spec: { ...spec, weeklyTargets: [] } }, 'spec.weeklyTargets must be an object'],
    ] as const) {
      const { res, captured } = makeRes();
      await handler(makeReq('POST', body), res);
      expect(captured.statusCode).toBe(400);
      expect(captured.body).toBe(message);
    }
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('answers ok:false with the generator\'s own words for a spec it refuses', async () => {
    mockedAdmin.mockReturnValue(makeAdmin([]));
    const nameless = makeRes();
    await handler(makeReq('POST', { spec: { ...spec, namePrefix: '  ' } }), nameless.res);
    expect(nameless.captured.statusCode).toBe(200);
    expect(nameless.captured.body).toEqual({ ok: false, problem: 'A cycle needs a name' });

    // Per-block validation speaks too: 53 weeks on breaks the 52-week cap.
    const long = makeRes();
    await handler(makeReq('POST', { spec: { ...spec, weeksOn: 53, weeksOff: 0, cycles: 1 } }), long.res);
    expect(long.captured.statusCode).toBe(200);
    expect(long.captured.body).toMatchObject({ ok: false });
    expect(String((long.captured.body as { problem: string }).problem)).toMatch(/52/);

    const tooMany = makeRes();
    await handler(makeReq('POST', { spec: { ...spec, cycles: 13 } }), tooMany.res);
    expect(tooMany.captured.body).toEqual({ ok: false, problem: 'That would create more than 24 blocks — shorten the plan' });
  });

  it('previews the blocks two ways — camelCase for rendering, rows for the batch commit', async () => {
    const state: { wrote?: boolean } = {};
    mockedAdmin.mockReturnValue(makeAdmin([], state));
    const { res, captured } = makeRes();
    await handler(makeReq('POST', { spec }), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as {
      ok: boolean; blocks: ReturnType<typeof generateCycle>; rows: unknown[]; totalWeeks: number; conflict: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.conflict).toBeNull();
    expect(body.totalWeeks).toBe(16);
    expect(body.blocks).toEqual(generateCycle(spec));
    expect(body.blocks).toHaveLength(8);
    expect(body.blocks[0]).toMatchObject({ name: 'Spring · Build 1', phase: 'build', startDate: '2027-01-04', endDateExclusive: '2027-01-25' });
    expect(body.blocks[1]).toMatchObject({ name: 'Spring · Recovery 1', phase: 'recovery', weeklyTargets: { cardioMinutes: 150, strengthSessions: 1 } });
    // Each row is exactly what `?batch=1` inserts for that block.
    expect(body.rows).toEqual(body.blocks.map(blockToRow));
    expect(state.wrote).toBeUndefined();
    // Reads bucket: the preview fires on a debounce and writes nothing.
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
  });

  it('names the first existing block the cycle would overlap', async () => {
    mockedAdmin.mockReturnValue(makeAdmin([
      existingRow('blk-old', 'Autumn Base', '2026-08-31', '2026-09-28'),
      existingRow('blk-hit', 'Winter Build', '2027-01-18', '2027-02-15'),
    ]));
    const { res, captured } = makeRes();
    await handler(makeReq('POST', { spec }), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      ok: true,
      conflict: { id: 'blk-hit', name: 'Winter Build', startDate: '2027-01-18', endDateExclusive: '2027-02-15' },
    });
    // The preview is still rendered — the editor shows both.
    expect((captured.body as { blocks: unknown[] }).blocks).toHaveLength(8);
  });

  it('drops a blank objective and treats a missing weeklyTargets as none', async () => {
    mockedAdmin.mockReturnValue(makeAdmin([]));
    const { res, captured } = makeRes();
    const { weeklyTargets: _drop, ...bare } = spec;
    await handler(makeReq('POST', { spec: { ...bare, objectiveId: '', intent: null } }), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as { ok: boolean; blocks: Array<{ objectiveId?: string; intent: string; weeklyTargets: unknown }> };
    expect(body.ok).toBe(true);
    expect(body.blocks[0].objectiveId).toBeUndefined();
    expect(body.blocks[0].intent).toBe('');
    expect(body.blocks[0].weeklyTargets).toEqual({});
  });
});
