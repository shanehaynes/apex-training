import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { instrumentMessages, type CoachRunSurface } from '../_lib/coachRuns';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import type { ChatMode } from '../_lib/coach/context';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

// instrumentMessages against the REAL SDK client (only fetch is faked): the
// wrapper must hand back the SDK's own APIPromise, record non-streaming calls
// from a side branch, and let stream: true — including messages.stream(),
// which calls this.create(...).withResponse() through the proxy — through
// untouched, with no phantom row.

const MESSAGE = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 9, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
};

function sse(): string {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { ...MESSAGE, content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

function setup(status = 200) {
  const runs: Array<Record<string, unknown>> = [];
  let fetches = 0;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    fetches += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    if (status !== 200) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
        { status, headers: { 'content-type': 'application/json' } });
    }
    return body.stream
      ? new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(MESSAGE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const admin = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { expect(table).toBe('coach_runs'); runs.push(row); return { error: null }; },
    }),
  } as unknown as Admin;
  const real = new Anthropic({ apiKey: 'x', fetch: fetch as never, maxRetries: 0 });
  const wrapped = instrumentMessages(real, admin, {
    user_id: 'u-1', mode: 'reflection', prompt_version: 'abc123abc123', client: 'cron',
  });
  return { runs, wrapped, fetches: () => fetches };
}

const params = { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

describe('instrumentMessages on a real SDK client', () => {
  it('create resolves to the message and records one row with its tokens', async () => {
    const { runs, wrapped } = setup();
    const message = await wrapped.client.messages.create(params);
    expect(message.content).toEqual(MESSAGE.content);
    await wrapped.settled();
    expect(runs).toEqual([{
      user_id: 'u-1', mode: 'reflection', model: 'claude-test', prompt_version: 'abc123abc123', client: 'cron',
      with_tools: false, request_id: expect.any(String),
      input_tokens: 120, output_tokens: 9, cache_read_tokens: 4, cache_write_tokens: 2,
      stop_reason: 'end_turn', latency_ms: expect.any(Number),
    }]);
  });

  it('create still returns the APIPromise: withResponse works, and the call is recorded once', async () => {
    const { runs, wrapped, fetches } = setup();
    const promise = wrapped.client.messages.create(params);
    expect(typeof promise.withResponse).toBe('function');
    const { data, response } = await promise.withResponse();
    expect(data.id).toBe('msg_1');
    expect(response.status).toBe(200);
    await wrapped.settled();
    expect(runs).toHaveLength(1);
    expect(fetches()).toBe(1);
  });

  it('records a call that fails, and the caller still sees the rejection', async () => {
    const { runs, wrapped } = setup(400);
    await expect(wrapped.client.messages.create(params)).rejects.toThrow(/bad model/);
    await wrapped.settled();
    expect(runs).toEqual([expect.objectContaining({ mode: 'reflection', model: 'claude-test', error: expect.stringMatching(/bad model/) })]);
  });

  it('messages.stream() works through the proxy and writes no row', async () => {
    const { runs, wrapped, fetches } = setup();
    const final = await wrapped.client.messages.stream(params).finalMessage();
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'streamed' });
    await wrapped.settled();
    expect(runs).toEqual([]);
    expect(fetches()).toBe(1);
  });

  it('create({ stream: true }) passes through unrecorded', async () => {
    const { runs, wrapped } = setup();
    const stream = await wrapped.client.messages.create({ ...params, stream: true });
    for await (const _event of stream) { /* drain */ }
    await wrapped.settled();
    expect(runs).toEqual([]);
  });
});

// Every mode a writer can send must be allowed by the CHECK the database
// actually has: the latest migration that (re)defines coach_runs_mode_check.
// The Records fail to compile when ChatMode or CoachRunSurface grows a value
// this list does not name.
const CHAT_MODES: Record<ChatMode, true> = { chat: true, builder: true, analytics: true, planner: true };
const SURFACES: Record<CoachRunSurface, true> = { summary: true, weekly: true, reflection: true, recap: true };

describe('coach_runs_mode_check', () => {
  it('the latest migration defining it allows every chat mode and every surface', () => {
    const dir = join(__dirname, '../../supabase/migrations');
    const phase = (f: string) => Number(/^phase(\d+)_/.exec(f)?.[1] ?? -1);
    const latest = readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => phase(a) - phase(b) || a.localeCompare(b))
      .map(f => ({ f, sql: readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '') }))
      .filter(({ sql }) => /add\s+constraint\s+coach_runs_mode_check/i.test(sql))
      .at(-1);
    expect(latest).toBeDefined();
    const match = /add\s+constraint\s+coach_runs_mode_check\s+check\s*\(\s*mode\s+in\s*\(([^)]*)\)/i.exec(latest!.sql);
    expect(match, latest!.f).not.toBeNull();
    const allowed = match![1].split(',').map(v => v.trim().replace(/^'|'$/g, ''));
    for (const mode of [...Object.keys(CHAT_MODES), ...Object.keys(SURFACES)]) {
      expect(allowed, `${latest!.f} is missing '${mode}'`).toContain(mode);
    }
  });
});
