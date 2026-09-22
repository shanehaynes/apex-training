import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { cachedToolSchemas, streamToWireEvents, withConversationBreakpoint } from '../chat';
import type { UpstreamEvent } from '../chat';
import { COACH_MODEL } from '../../src/lib/coach/model';
import type { ChatWireEvent } from '../../src/lib/coach/wire';

// Captures the exact request shape handed to the SDK (model id, cache
// breakpoints, abort options) without any network traffic; the stream itself
// is an empty async iterable, which streamToWireEvents drains to a bare
// 'done'.
const { streamMock, clientOptions } = vi.hoisted(() => ({
  streamMock: vi.fn((..._args: unknown[]) => (async function* (): AsyncGenerator<never> {})()),
  /** Every options object handed to `new Anthropic(...)` — the timeout and
   *  retry budget are as load-bearing as the request params (anthropicClient.ts). */
  clientOptions: [] as Array<Record<string, unknown>>,
}));
vi.mock('@anthropic-ai/sdk', () => ({
  // A function expression, not an arrow: the handler calls `new Anthropic(...)`.
  default: vi.fn(function (options: Record<string, unknown>) {
    clientOptions.push(options);
    return { messages: { stream: streamMock } };
  }),
}));

// Handler-level mocks (the streamToWireEvents suite below never hits them).
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
// The admin double answers the two shapes the handler drives through it: the
// key lookup's select chain, and coach_runs' insert (api/_lib/coachRuns.ts).
const { coachRuns, insertError } = vi.hoisted(() => ({
  coachRuns: [] as Array<Record<string, unknown>>,
  /** Boxed so a test can make one insert fail without re-mocking the module. */
  insertError: { value: null as { message: string } | null },
}));
vi.mock('../_lib/supabaseAdmin.js', () => ({
  getSupabaseAdmin: vi.fn(() => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      insert: async (row: Record<string, unknown>) => {
        if (table === 'coach_runs') coachRuns.push(row);
        return { error: insertError.value };
      },
    }),
  })),
}));
const { reportErrorMock } = vi.hoisted(() => ({
  reportErrorMock: vi.fn(async (_err: unknown, _context: { route: string; method?: string }) => {}),
}));
vi.mock('../_lib/errorReport.js', () => ({ reportError: reportErrorMock }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn(async () => null) }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
// The server-side prompt builder (W5a): scripted here; its own suite is
// api/__tests__/coach-context.test.ts.
vi.mock('../_lib/coach/context.js', () => {
  class ChatContextError extends Error {}
  return {
    ChatContextError,
    isChatMode: (v: unknown) => v === 'chat' || v === 'builder' || v === 'analytics',
    buildChatContext: vi.fn(async (_db: unknown, _u: string, mode: string, today: unknown) => {
      if (typeof today !== 'string' || today === 'bad') throw new ChatContextError('today must be a YYYY-MM-DD date');
      return {
        system: `SERVER PROMPT (${mode})`,
        toolContext: {
          definitions: new Map(),
          events: [{ id: 'evt-9', title: 'Leg day', date: '2026-09-04', type: 'weights', estimatedDuration: 60, isCompleted: false }],
          meals: [],
        },
      };
    }),
  };
});
import { buildChatContext } from '../_lib/coach/context';

import { getAnthropicKey } from '../_lib/anthropicKey';
import { enforceRateLimit } from '../_lib/rateLimit';
import { PROMPT_VERSION } from '../../src/lib/coach/prompt';

beforeEach(() => {
  coachRuns.length = 0;
  clientOptions.length = 0;
  insertError.value = null;
  reportErrorMock.mockClear();
});

async function* upstream(events: UpstreamEvent[]): AsyncIterable<UpstreamEvent> {
  for (const event of events) yield event;
}

async function collect(events: UpstreamEvent[]): Promise<ChatWireEvent[]> {
  const out: ChatWireEvent[] = [];
  await streamToWireEvents(upstream(events), e => out.push(e));
  return out;
}

describe('streamToWireEvents', () => {
  it('forwards text deltas and ends with done', async () => {
    const out = await collect([
      { type: 'message_start' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop' },
      { type: 'message_stop' },
    ]);
    expect(out).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'done' },
    ]);
  });

  it('buffers partial tool-input JSON and emits one complete tool_use', async () => {
    const out = await collect([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"abc","scope":"all"}' } },
      { type: 'content_block_stop' },
    ]);
    expect(out).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'delete_event', input: { event_id: 'abc', scope: 'all' } },
      { type: 'done' },
    ]);
  });

  it('treats an empty tool input as {}', async () => {
    const out = await collect([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_2', name: 'create_event' } },
      { type: 'content_block_stop' },
    ]);
    expect(out[0]).toEqual({ type: 'tool_use', id: 'tu_2', name: 'create_event', input: {} });
  });

  it('emits one tool_use event per block when the model calls tools in parallel', async () => {
    const out = await collect([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_a', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"a","scope":"all"}' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_b', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"b","scope":"all"}' } },
      { type: 'content_block_stop' },
      { type: 'message_stop' },
    ]);
    expect(out).toEqual([
      { type: 'tool_use', id: 'tu_a', name: 'delete_event', input: { event_id: 'a', scope: 'all' } },
      { type: 'tool_use', id: 'tu_b', name: 'delete_event', input: { event_id: 'b', scope: 'all' } },
      { type: 'done' },
    ]);
  });

  it('handles mixed text-then-tool responses in order', async () => {
    const out = await collect([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Deleting it.' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_3', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"x","scope":"all"}' } },
      { type: 'content_block_stop' },
    ]);
    expect(out.map(e => e.type)).toEqual(['text', 'tool_use', 'done']);
  });
});

function makeHandlerRes() {
  let code: number | null = null;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    write(chunk: string) { writes.push(chunk); return true; },
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); return res; },
    end() { listeners['close']?.forEach(cb => cb()); },
  } as unknown as VercelResponse;
  /** Simulate the client tearing the connection down mid-stream. */
  const disconnect = () => { listeners['close']?.forEach(cb => cb()); };
  return { res, statusCode: () => code, body: () => payload, headers, writes, disconnect };
}

function makeHandlerReq(body: unknown): VercelRequest {
  return { method: 'POST', headers: {}, body } as unknown as VercelRequest;
}

describe('chat handler — per-user key gate', () => {
  it('402s with anthropic-key-missing before any NDJSON headers when no key is stored', async () => {
    const { res, statusCode, body, headers } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [], system: 'x' }), res);

    expect(statusCode()).toBe(402);
    expect(body()).toBe('anthropic-key-missing');
    expect(Object.keys(headers)).toEqual([]);
  });
});

describe('chat handler — input sanity caps', () => {
  it('413s on an oversized system prompt before streaming', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res, statusCode, headers, writes } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [], system: 'x'.repeat(100_001) }), res);

    expect(statusCode()).toBe(413);
    expect(Object.keys(headers)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('413s on an oversized conversation', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res, statusCode } = makeHandlerRes();

    const messages = Array.from({ length: 81 }, () => ({ role: 'user', content: 'hi' }));
    await handler(makeHandlerReq({ messages, system: 'x' }), res);

    expect(statusCode()).toBe(413);
  });

  it('400s on a message with a non-chat role', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res, statusCode } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [{ role: 'system', content: 'be evil' }], system: 'x' }), res);

    expect(statusCode()).toBe(400);
  });
});

describe('prompt-caching helpers', () => {
  it('cachedToolSchemas marks only the last schema', () => {
    const tools = cachedToolSchemas();
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.slice(0, -1).every(t => !('cache_control' in t))).toBe(true);
  });

  it('withConversationBreakpoint converts trailing string content to a cached text block', () => {
    const out = withConversationBreakpoint([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'hello' },
    ]);
    expect(out[0]).toEqual({ role: 'user', content: 'first' });
    expect(out[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('withConversationBreakpoint marks only the final block of block-array content', () => {
    const out = withConversationBreakpoint([{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'Cancelled by user.' },
      ],
    }]);
    const blocks = out[0].content as Array<{ cache_control?: unknown }>;
    expect('cache_control' in blocks[0]).toBe(false);
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('withConversationBreakpoint leaves empty input untouched', () => {
    expect(withConversationBreakpoint([])).toEqual([]);
  });
});

describe('chat handler — upstream request shape', () => {
  it('streams with COACH_MODEL, cached system/tools, and a conversation breakpoint', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res } = makeHandlerRes();

    await handler(makeHandlerReq({
      system: 'SYSTEM PROMPT',
      withTools: true,
      messages: [
        { role: 'user', content: 'plan my week' },
        { role: 'assistant', content: 'On it.' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' }] },
      ],
    }), res);

    expect(streamMock).toHaveBeenCalledTimes(1);
    const params = streamMock.mock.calls[0][0] as unknown as Anthropic.MessageStreamParams;
    expect(params.model).toBe(COACH_MODEL);
    expect(params.system).toEqual([
      { type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } },
    ]);
    // Untouched history, breakpoint on the final block only.
    expect(params.messages[0]).toEqual({ role: 'user', content: 'plan my week' });
    const lastContent = params.messages.at(-1)?.content as Array<{ cache_control?: unknown }>;
    expect(lastContent.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools?.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });

    // The upstream request must carry an abort signal (see the abort suite).
    const options = streamMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the tools+system prefix identical when tools are off, gating with tool_choice', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res } = makeHandlerRes();

    await handler(makeHandlerReq({
      system: 'SYSTEM PROMPT',
      withTools: false,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' }] }],
    }), res);

    const params = streamMock.mock.calls.at(-1)![0] as unknown as Anthropic.MessageStreamParams;
    // Dropping the tools would invalidate the tools, system AND messages
    // tiers, so the re-stream could never read the tools-on turn's entry.
    expect(params.tools).toEqual(cachedToolSchemas());
    expect(params.tool_choice).toEqual({ type: 'none' });
    // No messages breakpoint: flipping tool_choice invalidates that tier, so
    // the entry would be written at 1.25x and never read.
    const lastContent = params.messages.at(-1)?.content as Array<{ cache_control?: unknown }>;
    expect('cache_control' in lastContent.at(-1)!).toBe(false);
  });
});

describe('chat handler — abort propagation', () => {
  it('aborts the upstream stream when the client disconnects mid-stream, without a wire error', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');

    // A stream that hangs until its abort signal fires, like a long
    // generation would.
    let captured: AbortSignal | undefined;
    streamMock.mockImplementationOnce((...args: unknown[]) => {
      captured = (args[1] as { signal: AbortSignal }).signal;
      const signal = captured;
      // Not a generator: streamToWireEvents only needs an AsyncIterable whose
      // first next() hangs until the abort signal rejects it.
      const pending = new Promise<IteratorResult<never>>((_, reject) => {
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        // The signal may have fired before iteration starts.
        if (signal.aborted) return fail();
        signal.addEventListener('abort', fail);
      });
      return { [Symbol.asyncIterator]: () => ({ next: () => pending }) } as AsyncGenerator<never>;
    });

    const { res, writes, disconnect } = makeHandlerRes();
    const running = handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }), res);

    // Let the handler reach the streaming stage (`captured` is set inside
    // the stream mock; mock.calls can't gate this — it accumulates across
    // tests), then drop the connection.
    await vi.waitFor(() => { if (!captured) throw new Error('stream not started'); });
    disconnect();
    await running;

    expect(captured?.aborted).toBe(true);
    expect(writes.join('')).not.toContain('"error"');
  });

  it('does not abort after a normally completed stream', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }), res);

    // res.end() fires 'close' on the double, mirroring Node — the signal
    // must stay unaborted so the SDK doesn't cancel a finished request.
    const options = streamMock.mock.calls.at(-1)?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
  });
});

describe('chat handler — rate limit', () => {
  it('429s before any NDJSON when the rate limiter blocks', async () => {
    vi.mocked(enforceRateLimit).mockImplementationOnce(async (_s, res) => {
      res.status(429).send('Too many requests');
      return false;
    });
    const { res, statusCode, headers, writes } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [], system: 'x' }), res);

    expect(statusCode()).toBe(429);
    expect(Object.keys(headers)).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe('chat handler — v2 body: server-side prompt (W5a)', () => {
  it('builds the system prompt from mode/today/context instead of trusting the body', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res } = makeHandlerRes();
    await handler(makeHandlerReq({
      mode: 'builder', today: '2026-09-03', withTools: true,
      context: { draft: { title: 'Push' } },
      messages: [{ role: 'user', content: 'add bench' }],
    }), res);
    expect(buildChatContext).toHaveBeenLastCalledWith(expect.anything(), 'user-123', 'builder', '2026-09-03', { title: 'Push' });
    const params = streamMock.mock.calls.at(-1)![0] as unknown as Anthropic.MessageStreamParams;
    expect(params.system).toEqual([{ type: 'text', text: 'SERVER PROMPT (builder)', cache_control: { type: 'ephemeral' } }]);
    // The builder mode's tool list, chosen from `mode`.
    expect((params.tools as Array<{ name: string }>).map(t => t.name)).toEqual(['update_workout_draft']);
  });

  it('400s a v2 body without a valid today, and one with neither today nor a legacy system', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValue('sk-test');
    const a = makeHandlerRes();
    await handler(makeHandlerReq({ mode: 'chat', today: 'bad', messages: [{ role: 'user', content: 'hi' }] }), a.res);
    expect(a.statusCode()).toBe(400);
    expect(a.body()).toBe('today must be a YYYY-MM-DD date');

    const b = makeHandlerRes();
    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }] }), b.res);
    expect(b.statusCode()).toBe(400);
    expect(streamMock).not.toHaveBeenCalledWith(expect.objectContaining({ system: undefined }));
    vi.mocked(getAnthropicKey).mockReset();
    vi.mocked(getAnthropicKey).mockResolvedValue(null);
  });

  it('labels tool_use events with real context on a v2 turn, and leaves legacy turns unlabelled', async () => {
    const toolTurn: UpstreamEvent[] = [
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"evt-9","scope":"all"}' } },
      { type: 'content_block_stop' },
    ];
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    streamMock.mockImplementationOnce(() => upstream(toolTurn) as never);
    const v2 = makeHandlerRes();
    await handler(makeHandlerReq({ mode: 'chat', today: '2026-09-03', withTools: true, messages: [{ role: 'user', content: 'delete leg day' }] }), v2.res);
    const v2Events = v2.writes.join('').trim().split('\n').map(l => JSON.parse(l) as ChatWireEvent);
    const labelled = v2Events.find(e => e.type === 'tool_use') as { label?: string; input: unknown };
    expect(labelled.label).toBe('Delete: Leg day · 2026-09-04 (entire series)');
    expect(labelled.input).toEqual({ event_id: 'evt-9', scope: 'all' });

    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    streamMock.mockImplementationOnce(() => upstream(toolTurn) as never);
    const legacy = makeHandlerRes();
    await handler(makeHandlerReq({ system: 'x', withTools: true, messages: [{ role: 'user', content: 'delete leg day' }] }), legacy.res);
    const legacyEvents = legacy.writes.join('').trim().split('\n').map(l => JSON.parse(l) as ChatWireEvent);
    expect((legacyEvents.find(e => e.type === 'tool_use') as { label?: string }).label).toBeUndefined();
  });
});

describe('chat handler — model selection', () => {
  /** Run one turn and return the params handed to the SDK. */
  async function paramsFor(body: Record<string, unknown>) {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res } = makeHandlerRes();
    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x', ...body }), res);
    return streamMock.mock.calls.at(-1)?.[0] as unknown as Anthropic.MessageStreamParams;
  }

  it('falls back to the default model when the body names none', async () => {
    const params = await paramsFor({});
    expect(params.model).toBe(COACH_MODEL);
  });

  it('honours an allowlisted model id', async () => {
    const params = await paramsFor({ model: 'claude-sonnet-5' });
    expect(params.model).toBe('claude-sonnet-5');
  });

  it('falls back to the default for an id outside the catalog', async () => {
    // Covers a forged body AND a real user still holding a retired id in
    // profiles.coach_model — neither may reach the API verbatim.
    for (const model of ['gpt-4o', '', 'claude-opus-9', 42, null]) {
      const params = await paramsFor({ model });
      expect(params.model).toBe(COACH_MODEL);
    }
  });

  it('sends adaptive thinking on models that support it', async () => {
    const params = await paramsFor({ model: 'claude-opus-4-8' });
    expect(params.thinking).toEqual({ type: 'adaptive' });
  });

  it('omits thinking entirely on Haiku 4.5, which rejects the adaptive form', async () => {
    // The 400 this guards against is silent in every other test: the params
    // are well-formed TypeScript, and only the live API refuses them.
    const params = await paramsFor({ model: 'claude-haiku-4-5-20251001' });
    expect(params.model).toBe('claude-haiku-4-5-20251001');
    expect(params).not.toHaveProperty('thinking');
  });

  it('keeps the cache breakpoints regardless of model', async () => {
    const params = await paramsFor({ model: 'claude-haiku-4-5-20251001', withTools: true });
    expect(params.system).toEqual([
      { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } },
    ]);
    expect(params.tools?.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });
});

describe('chat handler — telemetry and error seam', () => {
  /** A stream that carries usage, one tool_use block and a stop_reason. */
  function measuredTurn(): UpstreamEvent[] {
    return [
      { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"evt-9","scope":"all"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { type: 'message_delta', stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    ];
  }

  it('builds the SDK client with a bounded timeout and one retry', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const { res } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }), res);

    // 20s is per attempt and bounds time-to-headers, so two attempts fit
    // inside api/chat.ts's 60s maxDuration — see api/_lib/anthropicClient.ts.
    expect(clientOptions.at(-1)).toMatchObject({ maxRetries: 1, timeout: 20000 });
  });

  it('stamps x-apex-request-id on the streaming path and records one coach_runs row', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    streamMock.mockImplementationOnce(() => upstream(measuredTurn()) as never);
    const { res, headers } = makeHandlerRes();

    await handler(makeHandlerReq({
      mode: 'builder', today: '2026-09-03', withTools: true,
      messages: [{ role: 'user', content: 'add bench' }],
    }), res);

    expect(headers['x-apex-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(coachRuns).toHaveLength(1);
    expect(coachRuns[0]).toMatchObject({
      user_id: 'user-123',
      request_id: headers['x-apex-request-id'],
      mode: 'builder',
      model: COACH_MODEL,
      prompt_version: PROMPT_VERSION,
      client: 'web',
      with_tools: true,
      input_tokens: 11,
      cache_read_tokens: 7,
      cache_write_tokens: 3,
      output_tokens: 42,
      tool_use_count: 1,
      stop_reason: 'tool_use',
    });
    expect(coachRuns[0]).not.toHaveProperty('error');
    expect(typeof coachRuns[0].latency_ms).toBe('number');
  });

  it('leaves the wire output and status untouched when the row cannot be stored', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    streamMock.mockImplementationOnce(() => upstream(measuredTurn()) as never);
    insertError.value = { message: 'permission denied for table coach_runs' };
    const { res, statusCode, writes } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x', withTools: true }), res);

    // Telemetry fails open: the stream is the product, the row is a footnote.
    expect(statusCode()).toBeNull();
    const events = writes.join('').trim().split('\n').map(l => JSON.parse(l) as ChatWireEvent);
    expect(events.map(e => e.type)).toEqual(['tool_use', 'done']);
  });

  it('reports a failed stream through the error seam and records the failure', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    streamMock.mockImplementationOnce(() => { throw new Error('upstream exploded'); });
    const { res, writes } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }), res);

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][1]).toEqual({ route: '/api/chat', method: 'POST' });
    expect(writes.join('')).toContain('"Chat request failed"');
    expect(coachRuns).toHaveLength(1);
    expect(coachRuns[0]).toMatchObject({
      error: 'upstream exploded',
      input_tokens: 0, output_tokens: 0, tool_use_count: 0, stop_reason: null,
    });
    // The user-facing message never carries the id, and the row never a stack.
    expect(writes.join('')).not.toContain(coachRuns[0].request_id as string);
    expect(String(coachRuns[0].error)).not.toContain('at ');
  });

  it('caps a runaway error message at 500 characters', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    // An SDK error can carry a whole upstream response body in its message;
    // the column promises an error message, not a payload.
    streamMock.mockImplementationOnce(() => { throw new Error('x'.repeat(2000)); });
    const { res } = makeHandlerRes();

    await handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }), res);

    expect(coachRuns).toHaveLength(1);
    expect(coachRuns[0].error).toBe('x'.repeat(500));
  });

  it('records an aborted turn without calling the error seam', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    let captured: AbortSignal | undefined;
    streamMock.mockImplementationOnce((...args: unknown[]) => {
      captured = (args[1] as { signal: AbortSignal }).signal;
      const signal = captured;
      const pending = new Promise<IteratorResult<never>>((_, reject) => {
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) return fail();
        signal.addEventListener('abort', fail);
      });
      return { [Symbol.asyncIterator]: () => ({ next: () => pending }) } as AsyncGenerator<never>;
    });

    const { res, disconnect } = makeHandlerRes();
    const running = handler(makeHandlerReq({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }), res);
    await vi.waitFor(() => { if (!captured) throw new Error('stream not started'); });
    disconnect();
    await running;

    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(coachRuns).toHaveLength(1);
    expect(coachRuns[0]).toMatchObject({ error: 'client aborted', latency_ms: expect.any(Number) });
  });
});

describe('chat handler — request id is absent from the plain-HTTP error paths', () => {
  it('sets no headers on 402, 413 or 429', async () => {
    const noKey = makeHandlerRes();
    await handler(makeHandlerReq({ messages: [], system: 'x' }), noKey.res);
    expect(noKey.headers['x-apex-request-id']).toBeUndefined();

    vi.mocked(getAnthropicKey).mockResolvedValueOnce('sk-test');
    const tooBig = makeHandlerRes();
    await handler(makeHandlerReq({ messages: [], system: 'x'.repeat(100_001) }), tooBig.res);
    expect(tooBig.headers['x-apex-request-id']).toBeUndefined();

    vi.mocked(enforceRateLimit).mockImplementationOnce(async (_s, res) => {
      res.status(429).send('Too many requests');
      return false;
    });
    const limited = makeHandlerRes();
    await handler(makeHandlerReq({ messages: [], system: 'x' }), limited.res);
    expect(limited.headers['x-apex-request-id']).toBeUndefined();
  });
});
