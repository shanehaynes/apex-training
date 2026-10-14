import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachSummary';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

// The post-workout summary writes one coach_runs row per model call
// (phase57): mode 'summary', the resolved model, the four token counts, and
// `error` when the call fails — on both the streamed and the legacy shape.

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn(async () => 'sk-ant-test') }));
vi.mock('../_lib/trackerSession.js', () => ({
  loadResolvedOccurrence: vi.fn(async () => ({ id: 'evt-1', date: '2026-08-07', title: 'Bench', type: 'weights', exercises: [] })),
  buildFinishSummary: vi.fn(async () => ({ groups: [], prs: [], scoreRecord: null, recap: 'Workout: Bench' })),
}));

const { sdk } = vi.hoisted(() => ({
  sdk: {
    streamFails: false,
    createFails: false,
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream: () => (async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 812, cache_read_input_tokens: 40, cache_creation_input_tokens: 7 } } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Strong session.' } };
        if (sdk.streamFails) throw new Error('upstream 529 overloaded');
        yield { type: 'message_delta', delta: { type: 'message_delta', stop_reason: 'end_turn' }, usage: { output_tokens: 41 } };
      })(),
      create: async () => {
        if (sdk.createFails) throw new Error('invalid x-api-key');
        return {
          content: [{ type: 'text', text: 'One-shot.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    };
  },
}));

let runs: Array<Record<string, unknown>>;

function makeAdmin() {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({
      data: { finished_at: '2026-08-07T10:00:00Z', total_duration_seconds: 1800, score_type: null, coach_model: null },
      error: null,
    }),
    update: () => chain,
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  };
  return {
    from: (table: string) => (table === 'coach_runs'
      ? { insert: async (row: Record<string, unknown>) => { runs.push(row); return { error: null }; } }
      : chain),
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown): VercelRequest {
  return { method: 'POST', headers: {}, query: {}, body } as unknown as VercelRequest;
}

function makeRes() {
  const res = {
    status() { return res; }, send() { return res; }, json() { return res; },
    setHeader() { return res; }, write() { return true; }, end() { return res; }, on() { return res; },
  } as unknown as VercelResponse;
  return res;
}

beforeEach(() => {
  runs = [];
  sdk.streamFails = false;
  sdk.createFails = false;
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin());
});

const base = {
  user_id: 'user-123',
  mode: 'summary',
  model: expect.any(String),
  prompt_version: expect.stringMatching(/^[0-9a-f]{12}$/),
  client: 'web',
  with_tools: false,
  request_id: expect.any(String),
};

describe('coach-summary coach_runs rows', () => {
  it('records the streamed summary with its token counts', async () => {
    await handler(makeReq({ eventId: 'evt-1', eventDate: '2026-08-07' }), makeRes());
    expect(runs).toEqual([{
      ...base,
      input_tokens: 812,
      cache_read_tokens: 40,
      cache_write_tokens: 7,
      output_tokens: 41,
      stop_reason: 'end_turn',
      latency_ms: expect.any(Number),
    }]);
  });

  it('records a stream that fails, with the error and zero output', async () => {
    sdk.streamFails = true;
    await handler(makeReq({ eventId: 'evt-1', eventDate: '2026-08-07' }), makeRes());
    expect(runs).toEqual([{ ...base, latency_ms: expect.any(Number), error: 'upstream 529 overloaded' }]);
  });

  it('records the legacy one-shot call', async () => {
    await handler(makeReq({ recap: 'Workout: Bench' }), makeRes());
    expect(runs).toEqual([expect.objectContaining({
      ...base, input_tokens: 500, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, stop_reason: 'end_turn',
    })]);
    expect(runs[0].error).toBeUndefined();
  });

  it('records a legacy call that throws', async () => {
    sdk.createFails = true;
    await handler(makeReq({ recap: 'Workout: Bench' }), makeRes());
    expect(runs).toEqual([expect.objectContaining({ ...base, error: 'invalid x-api-key' })]);
  });

  it('never puts the recap or the reply in the row', async () => {
    await handler(makeReq({ eventId: 'evt-1', eventDate: '2026-08-07' }), makeRes());
    const serialized = JSON.stringify(runs);
    expect(serialized).not.toContain('Workout: Bench');
    expect(serialized).not.toContain('Strong session.');
  });
});
