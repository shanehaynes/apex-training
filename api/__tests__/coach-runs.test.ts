import { describe, it, expect, vi, afterEach } from 'vitest';
import { recordCoachRun, type CoachRunInsert } from '../_lib/coachRuns';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const ROW: CoachRunInsert = {
  user_id: 'user-123',
  request_id: 'req-abc',
  mode: 'chat',
  model: 'claude-sonnet-5',
  prompt_version: 'coach-v3',
  client: 'ios/0.8.0(353)',
  with_tools: true,
  input_tokens: 1200,
  cache_read_tokens: 8000,
  cache_write_tokens: 0,
  output_tokens: 430,
  tool_use_count: 2,
  stop_reason: 'end_turn',
  latency_ms: 4100,
};

/** Every (table, row) the helper handed to the client, in order. */
let inserts: Array<{ table: string; row: unknown }>;

/**
 * The hand-rolled fake from mutations-log.test.ts: a `from(table)` recorder
 * whose terminal is a thenable, so `await admin.from(t).insert(r)` resolves
 * without postgrest-js in the way.
 */
function makeAdmin(
  outcome: { error: { message: string } | null } | { throws: Error },
): Admin {
  inserts = [];
  return {
    from(table: string) {
      return {
        insert(row: unknown) {
          inserts.push({ table, row });
          if ('throws' in outcome) throw outcome.throws;
          return {
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: outcome.error }).then(resolve),
          };
        },
      };
    },
  } as unknown as Admin;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordCoachRun', () => {
  it('inserts the row into coach_runs exactly as given', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await recordCoachRun(makeAdmin({ error: null }), ROW);

    expect(inserts).toEqual([{ table: 'coach_runs', row: ROW }]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('logs an insert error once and swallows it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordCoachRun(makeAdmin({ error: { message: 'permission denied for table coach_runs' } }), ROW),
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      '[api/coach-runs] insert failed:',
      'permission denied for table coach_runs',
    );
  });

  it('swallows a thrown rejection too — telemetry never fails the turn', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordCoachRun(makeAdmin({ throws: new Error('fetch failed') }), ROW),
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('[api/coach-runs] insert failed:', 'fetch failed');
  });
});
