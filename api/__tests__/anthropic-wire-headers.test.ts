import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { makeAnthropicClient } from '../_lib/anthropicClient';
import { makeClient as makeEvalClient } from '../../evals/src/models';
import { cachedToolSchemas } from '../chat';
import { resolveCoachModel } from '../../src/lib/coach/models';

// WHY THIS EXISTS
// The coach's request path is the real @anthropic-ai/sdk, but the eval gate
// runs on the agent-sdk backend (Claude Code), which never loads it. So an SDK
// bump that moves a wire default — 1.0 moved `anthropic-version` from
// 2023-06-01 to 2026-10-21 — passes re-attestation untouched. This test builds
// the production client with a stub `fetch` (no network, no tokens) and pins
// the headers and URL the SDK sends. If it fails after a bump, read the SDK's
// CHANGELOG for that change, decide whether the coach is fine on it, then edit
// the pinned values by hand — they are literals, not a snapshot file, so
// `vitest -u` cannot wave a wire change through.
//
// WHAT IS PINNED AND WHAT IS NOT
// Pinned: every header that changes API behaviour (`anthropic-version`,
// `anthropic-beta`, auth, content negotiation) and the request URL. Not
// pinned: User-Agent and the x-stainless-* telemetry headers, which carry the
// SDK version, OS, Node version and per-attempt counters — they change on
// every patch release and on every machine, and the API does not branch on
// them.

const KEY = 'sk-ant-test-not-a-real-key';

const IGNORED = (name: string) => name === 'user-agent' || name.startsWith('x-stainless-');

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const MESSAGE = {
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'stub',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function sse(): string {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { ...MESSAGE, content: [] } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Stubs global fetch BEFORE the client is built: the SDK resolves its fetch
 *  at construction (`options.fetch ?? getDefaultFetch()`), so the production
 *  factory is exercised unchanged. */
function stubFetch(bodies: unknown[] = []): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      if (!IGNORED(name)) headers[name] = value;
    });
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers });
    if (init?.body == null) {
      return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init.body)) as { stream?: boolean };
    bodies.push(body);
    return body.stream
      ? new Response(sse(), { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(MESSAGE), { headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

/** The request api/chat.ts streams on a chat turn with tools, on the default
 *  model: same params, same tool list (memory tool included), 1h cache TTL. */
function chatRequest(): Anthropic.MessageStreamParams {
  const model = resolveCoachModel(undefined);
  return {
    model: model.id,
    max_tokens: 8192,
    ...model.params,
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: cachedToolSchemas('chat', '1h'),
    messages: [{ role: 'user', content: 'hi' }],
  } as Anthropic.MessageStreamParams;
}

/** Recorded on @anthropic-ai/sdk 1.3.0. One expected request for every call
 *  below: the coach and the eval client must agree on the wire. 1.x sends the
 *  API key as `authorization: Bearer` (0.x sent `x-api-key`), and adds no
 *  `anthropic-beta` for the chat tool list, memory tool included. */
const PINNED: Captured = {
  url: 'https://api.anthropic.com/v1/messages',
  method: 'POST',
  headers: {
    accept: 'application/json',
    'anthropic-version': '2026-10-21',
    authorization: `Bearer ${KEY}`,
    'content-type': 'application/json',
  },
};

const MINIMAL: Anthropic.MessageCreateParamsNonStreaming = {
  model: 'claude-opus-5-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
};

beforeEach(() => {
  // Both are read when the client is built; blank them so a developer's
  // shell cannot redirect the URL or add headers to what is being pinned.
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Anthropic wire headers (pinned per @anthropic-ai/sdk version)', () => {
  it('the production client (api/_lib/anthropicClient.ts) on messages.create', async () => {
    const calls = stubFetch();
    await makeAnthropicClient(KEY).messages.create(MINIMAL);
    expect(calls).toEqual([PINNED]);
  });

  it("the production client on api/chat.ts's streamed chat request, tools and memory tool included", async () => {
    const bodies: unknown[] = [];
    const calls = stubFetch(bodies);
    await makeAnthropicClient(KEY).messages.stream(chatRequest()).finalMessage();
    expect(calls).toEqual([PINNED]);
    // The body too: a bump that adds a default field or drops one the coach
    // relies on (cache_control.ttl, thinking, output_config) fails here.
    expect(bodies).toEqual([{ ...chatRequest(), stream: true }]);
  });

  it('the production client on models.list, the key check (api/_lib/anthropicKey.ts)', async () => {
    const calls = stubFetch();
    await makeAnthropicClient(KEY).models.list({ limit: 1 });
    expect(calls).toEqual([{
      url: 'https://api.anthropic.com/v1/models?limit=1',
      method: 'GET',
      headers: { accept: PINNED.headers.accept, 'anthropic-version': PINNED.headers['anthropic-version'], authorization: PINNED.headers.authorization },
    }]);
  });

  it('the eval API backend client (evals/src/models.ts makeClient)', async () => {
    const calls = stubFetch();
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    await makeEvalClient().messages.create(MINIMAL);
    expect(calls).toEqual([PINNED]);
  });
});
