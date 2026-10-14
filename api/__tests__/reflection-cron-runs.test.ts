import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/reflectionCron';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getAnthropicKey } from '../_lib/anthropicKey';
import { reflectForUser } from '../_lib/reflection/reflect';

// The reflection cron hands reflectForUser a client whose every
// messages.create writes a coach_runs row (phase57): mode 'reflection', the
// model the call used, the token counts, and `error` when the call throws.
// reflectForUser is scripted to make the calls the real one makes (an ask
// and, on a parse failure, one retry).

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn() }));
vi.mock('../_lib/reflection/reflect.js', () => ({ reflectForUser: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: messagesCreate }; },
}));

let runs: Array<Record<string, unknown>>;

function makeAdmin() {
  return {
    from(table: string) {
      if (table === 'coach_runs') {
        return { insert: async (row: Record<string, unknown>) => { runs.push(row); return { error: null }; } };
      }
      const rows = table === 'profiles' ? [{ id: 'u-1', coach_model: 'claude-sonnet-5' }] : [];
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'order']) b[m] = () => b;
      b.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
      return b;
    },
  } as never;
}

function makeRes() {
  const res = { status() { return res; }, send() { return res; }, json() { return res; } } as unknown as VercelResponse;
  return res;
}
const req = { method: 'GET', headers: { authorization: 'Bearer test-secret' }, query: { day: '2026-10-13' } } as unknown as VercelRequest;

const usage = (input: number, output: number) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 5,
});

beforeEach(() => {
  vi.clearAllMocks();
  runs = [];
  process.env.CRON_SECRET = 'test-secret';
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
  vi.mocked(getAnthropicKey).mockResolvedValue('sk-ant-u-1');
  vi.mocked(reflectForUser).mockImplementation(async (_db, r) => {
    const ask = () => r.client.messages.create({ model: r.model, max_tokens: 10, messages: [{ role: 'user', content: 'day' }] });
    await ask();
    await ask();
    return { action: 'done', rowId: 'r1', memoriesProposed: 0, contractProposed: false };
  });
});

describe('reflection-cron coach_runs rows', () => {
  it('records every model call the reflection makes, under one request id', async () => {
    messagesCreate
      .mockResolvedValueOnce({ content: [], stop_reason: 'end_turn', usage: usage(900, 60) })
      .mockResolvedValueOnce({ content: [], stop_reason: 'max_tokens', usage: usage(1000, 70) });
    await handler(req, makeRes());
    const common = {
      user_id: 'u-1',
      mode: 'reflection',
      model: 'claude-sonnet-5',
      prompt_version: expect.stringMatching(/^[0-9a-f]{12}$/),
      client: 'cron',
      with_tools: false,
      cache_read_tokens: 3,
      cache_write_tokens: 5,
      latency_ms: expect.any(Number),
    };
    expect(runs).toEqual([
      { ...common, request_id: expect.any(String), input_tokens: 900, output_tokens: 60, stop_reason: 'end_turn' },
      { ...common, request_id: runs[0]?.request_id, input_tokens: 1000, output_tokens: 70, stop_reason: 'max_tokens' },
    ]);
  });

  it('records a call that throws, and still lets the reflection see the throw', async () => {
    messagesCreate.mockRejectedValue(new Error('credit balance too low'));
    let seen: unknown;
    vi.mocked(reflectForUser).mockImplementationOnce(async (_db, r) => {
      try {
        await r.client.messages.create({ model: r.model, max_tokens: 10, messages: [{ role: 'user', content: 'day' }] });
      } catch (err) { seen = err; }
      return { action: 'failed', rowId: 'r1', memoriesProposed: 0, contractProposed: false, error: 'x' };
    });
    await handler(req, makeRes());
    expect((seen as Error).message).toBe('credit balance too low');
    expect(runs).toEqual([expect.objectContaining({ mode: 'reflection', user_id: 'u-1', error: 'credit balance too low' })]);
  });

  it('writes no row for an athlete without a key', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValue(null);
    await handler(req, makeRes());
    expect(runs).toEqual([]);
  });
});
