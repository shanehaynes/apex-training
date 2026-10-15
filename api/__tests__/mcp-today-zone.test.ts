import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_WRITE_TOOLS } from '../_lib/mcp/connectorRegistry';
import { getTrainingBlocksTool } from '../_lib/mcp/tools/blocks';
import { buildCoachToolDeps } from '../_lib/coach/toolDeps';

// An MCP call without `today` is answered in the athlete's saved zone
// (profiles.timezone, phase58), not on the server's UTC date. 03:00Z on Oct
// 15 is 20:00 on the 14th in Los Angeles.

vi.mock('../_lib/coach/toolDeps.js', () => ({ buildCoachToolDeps: vi.fn(async () => { throw new Error('stop here'); }) }));

const USER = 'user-1';
const NOW = new Date('2026-10-15T03:00:00Z');

/** Answers the zone read; every other table is empty. */
function db(timezone: string | null) {
  const empty = { data: [], error: null };
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'gte', 'lte', 'lt', 'is', 'not', 'limit']) builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => void) => resolve(empty);
  return {
    from(table: string) {
      if (table === 'profiles') {
        return { select: () => ({ in: async () => ({ data: [{ id: USER, timezone }], error: null }) }) };
      }
      return builder;
    },
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('MCP today, absent from the call', () => {
  it('coach-backed write tools plan against the local date', async () => {
    const createEvent = MCP_WRITE_TOOLS.find(t => t.name === 'create_event')!;
    await expect(createEvent.run(db('America/Los_Angeles'), USER, { title: 'x' })).rejects.toThrow('stop here');
    expect(vi.mocked(buildCoachToolDeps).mock.calls[0][2]).toBe('2026-10-14');

    await expect(createEvent.run(db(null), USER, { title: 'x' })).rejects.toThrow('stop here');
    expect(vi.mocked(buildCoachToolDeps).mock.calls[1][2]).toBe('2026-10-15');
  });

  it('a sent `today` still wins', async () => {
    const createEvent = MCP_WRITE_TOOLS.find(t => t.name === 'create_event')!;
    await expect(createEvent.run(db('America/Los_Angeles'), USER, { title: 'x', today: '2026-10-20' })).rejects.toThrow('stop here');
    expect(vi.mocked(buildCoachToolDeps).mock.calls[0][2]).toBe('2026-10-20');
  });

  it('get_training_blocks reads "current" on the local date', async () => {
    const local = await getTrainingBlocksTool.run(db('America/Los_Angeles'), USER, {}) as { today?: string };
    const utc = await getTrainingBlocksTool.run(db(null), USER, {}) as { today?: string };
    expect([local.today, utc.today]).toEqual(['2026-10-14', '2026-10-15']);
  });
});
