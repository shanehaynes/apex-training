import { describe, it, expect } from 'vitest';
import type { Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { runCase } from '../src/harness';
import { makeApiBackend } from '../src/backends/api';
import {
  AgentSdkBackendError,
  MCP_PREFIX,
  makeAgentSdkBackend,
  stripMcpPrefix,
  tokensFromSdkUsage,
  zodShapeFromJsonSchema,
} from '../src/backends/agentSdk';
import { selectCases } from '../run';
import { coachToolSchemas } from '../../src/lib/coach/schemas';
import type { CallModel, EvalCase, ModelResponse } from '../src/types';

// The turn-level seam: the API backend must reproduce, byte for byte, the
// transcript the harness produced before it existed; the Agent SDK backend
// must rebuild the SAME ApiMessage[] shape out of a completely different
// message stream. Neither test touches a live model.

const BASE_CASE: EvalCase = {
  id: 'test-case', description: '',
  fixture: { today: '2026-08-03', events: [] },
  script: [{ kind: 'user', text: 'Create a workout for Friday.' }],
  expect: {},
};

const EVENT_INPUT = {
  type: 'weights', title: 'Friday Strength', date: '2026-08-07', estimated_duration: 60,
};

// ─── API backend ─────────────────────────────────────────────────────────────

describe('makeApiBackend', () => {
  function scriptedModel(responses: ModelResponse[]) {
    const requests: Array<{ system: string; withTools: boolean }> = [];
    let i = 0;
    const call: CallModel = async ({ system, withTools }) => {
      requests.push({ system, withTools });
      if (i >= responses.length) throw new Error('fake model ran out of responses');
      return responses[i++];
    };
    return { call, requests };
  }

  const response = (blocks: ModelResponse['content'], stopReason = 'end_turn'): ModelResponse =>
    ({ content: blocks, stopReason, usage: { inputTokens: 100, outputTokens: 50 } });

  it('reproduces the pre-seam transcript from a CallModel fake', async () => {
    const { call, requests } = scriptedModel([
      response([
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Creating it.' },
        { type: 'tool_use', id: 'tu-1', name: 'create_event', input: EVENT_INPUT },
      ], 'tool_use'),
      response([{ type: 'text', text: 'Done.' }]),
    ]);

    const result = await runCase(BASE_CASE, makeApiBackend(call));

    // Tools on, then the tools-off re-stream — production's tool_choice: none.
    expect(requests.map(r => r.withTools)).toEqual([true, false]);
    expect(result.transcript.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(result.transcript)).not.toContain('thinking');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('create_event');
    expect(result.toolCalls[0].result).toContain('Created "Friday Strength"');
    expect(result.finalEvents).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(result.usageUnavailable).toBeUndefined();
  });

  it('is what a bare CallModel is wrapped in, so both spellings agree', async () => {
    const blocks: ModelResponse['content'] = [
      { type: 'tool_use', id: 'tu-1', name: 'create_event', input: EVENT_INPUT },
    ];
    const viaBackend = await runCase(BASE_CASE, makeApiBackend(
      scriptedModel([response(blocks, 'tool_use'), response([{ type: 'text', text: 'Done.' }])]).call));
    const viaCallModel = await runCase(BASE_CASE,
      scriptedModel([response(blocks, 'tool_use'), response([{ type: 'text', text: 'Done.' }])]).call);
    expect(JSON.stringify(viaCallModel.transcript)).toBe(JSON.stringify(viaBackend.transcript));
    expect(viaCallModel.anomalies).toEqual(viaBackend.anomalies);
  });
});

// ─── Agent SDK backend ───────────────────────────────────────────────────────

type FakeTools = Array<SdkMcpToolDefinition<never>>;

const initMessage = (tools: string[] = [`${MCP_PREFIX}create_event`]) =>
  ({ type: 'system', subtype: 'init', session_id: 'sess-1', tools } as unknown as SDKMessage);

const assistantMessage = (content: unknown[], stopReason: string | null = null) =>
  ({
    type: 'assistant',
    message: { model: 'claude-sonnet-5', content, stop_reason: stopReason, usage: {} },
  } as unknown as SDKMessage);

const resultMessage = (over: Record<string, unknown> = {}) =>
  ({
    type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
    ...over,
  } as unknown as SDKMessage);

const toolResultMessage = (blocks: Array<{ tool_use_id: string; text: string }>) =>
  ({
    type: 'user',
    message: {
      content: blocks.map(b => ({
        type: 'tool_result', tool_use_id: b.tool_use_id,
        content: [{ type: 'text', text: b.text }],
      })),
    },
  } as unknown as SDKMessage);

/** Drives the coach tool the way a real session would: the SDK executes the
 *  MCP handler, then reports the result back as a user message. */
function fakeSdk(script: (tools: FakeTools) => Promise<SDKMessage[]> | SDKMessage[]) {
  const seen: Options[] = [];
  const runQuery = ({ options, tools }: { prompt: string; options: Options; tools: FakeTools }) => {
    seen.push(options);
    return (async function* () {
      for (const message of await script(tools)) yield message;
    })();
  };
  return { runQuery, seen };
}

async function callTool(tools: FakeTools, name: string, input: Record<string, unknown>) {
  const def = tools.find(t => t.name === name);
  if (!def) throw new Error(`fake SDK: no tool ${name}`);
  const out = await (def as unknown as {
    handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }>;
  }).handler(input, {});
  return out.content.map(c => c.text).join('');
}

describe('makeAgentSdkBackend', () => {
  it('rebuilds the API transcript shape from the SDK message stream', async () => {
    const { runQuery, seen } = fakeSdk(async tools => {
      const before: SDKMessage[] = [
        initMessage(),
        assistantMessage([
          { type: 'thinking', thinking: 'planning' },
          { type: 'text', text: 'Creating it.' },
          { type: 'tool_use', id: 'tu-1', name: `${MCP_PREFIX}create_event`, input: EVENT_INPUT },
        ]),
      ];
      // The SDK runs the tool inside its own session, reports the result back
      // as a user message, then keeps going.
      const text = await callTool(tools, 'create_event', EVENT_INPUT);
      return [
        ...before,
        toolResultMessage([{ tool_use_id: 'tu-1', text }]),
        assistantMessage([{ type: 'text', text: 'Done.' }], 'end_turn'),
        resultMessage(),
      ];
    });

    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));

    // Same four messages the API backend produces, despite no tools-off re-stream.
    expect(result.transcript.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(result.transcript)).not.toContain('thinking');
    const flush = result.transcript[2];
    expect((flush.content as Array<{ tool_use_id?: string; content?: string }>)[0].tool_use_id).toBe('tu-1');
    expect((flush.content as Array<{ content?: string }>)[0].content).toContain('Created "Friday Strength"');

    // The MCP prefix never reaches a checker, an expectation or the record.
    expect(result.toolCalls.map(c => c.name)).toEqual(['create_event']);
    expect(JSON.stringify(result.transcript)).not.toContain(MCP_PREFIX);
    expect(result.finalEvents).toHaveLength(1);
    expect(result.turns[0].assistantText).toBe('Creating it.\nDone.');
    // Cached reads counted at full weight so the token column stays comparable.
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
    expect(result.anomalies).toEqual([]);

    const options = seen[0];
    expect(options.tools).toEqual([]);          // built-ins off
    expect(options.settingSources).toEqual([]); // no personal config
    expect(options.model).toBe('claude-sonnet-5');
    expect(options.systemPrompt).toContain('EXERCISE LIBRARY');
  });

  // Regression: the first live run attached call 2's result to call 5 and gave
  // calls 2-4 "Unknown tool", because the pairing was derived from the order
  // the MCP handlers finished in. The SDK streams the next assistant message
  // before a handler's promise resolves, so only its own tool_use_id is
  // authoritative.
  it('pairs each result with its own call across several sequential rounds', async () => {
    const titles = ['First', 'Second', 'Third'];
    const { runQuery } = fakeSdk(async tools => {
      const out: SDKMessage[] = [initMessage()];
      for (const [i, title] of titles.entries()) {
        const input = { ...EVENT_INPUT, title, date: `2026-08-0${i + 4}` };
        out.push(assistantMessage([
          { type: 'tool_use', id: `tu-${i}`, name: `${MCP_PREFIX}create_event`, input },
        ]));
        const text = await callTool(tools, 'create_event', input);
        out.push(toolResultMessage([{ tool_use_id: `tu-${i}`, text }]));
      }
      out.push(assistantMessage([{ type: 'text', text: 'Week is set.' }], 'end_turn'), resultMessage());
      return out;
    });

    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));

    expect(result.anomalies).toEqual([]);
    expect(result.toolCalls).toHaveLength(3);
    for (const [i, title] of titles.entries()) {
      expect(result.toolCalls[i].input.title).toBe(title);
      // Each call's recorded result names that call's own event.
      expect(result.toolCalls[i].result).toContain(`Created "${title}"`);
    }
    expect(result.finalEvents.map(e => e.title)).toEqual(titles);
    expect(JSON.stringify(result.transcript)).not.toContain('Unknown tool');
  });

  it('does not invent a result for a tool_use the SDK never executed', async () => {
    const { runQuery } = fakeSdk(() => [
      initMessage(),
      assistantMessage([
        { type: 'tool_use', id: 'tu-1', name: `${MCP_PREFIX}create_event`, input: EVENT_INPUT },
      ], 'end_turn'),
      resultMessage(),
    ]);
    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));
    // Recorded as an anomaly, NOT as a confirmed mutation.
    expect(result.anomalies).toEqual(['sdkToolUseUnexecuted:create_event (turn 1)']);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.finalEvents).toHaveLength(0);
    expect(JSON.stringify(result.transcript)).not.toContain('Unknown tool');
  });

  it('closes the query so subprocesses do not accumulate across a suite', async () => {
    let closed = 0;
    const runQuery = () => {
      const iter = (async function* () {
        yield initMessage([]);
        yield assistantMessage([{ type: 'text', text: 'ok' }], 'end_turn');
        yield resultMessage();
      })();
      return Object.assign(iter, { close: () => { closed += 1; } });
    };
    await runCase(
      { ...BASE_CASE, script: [{ kind: 'user', text: 'One.' }, { kind: 'user', text: 'Two.' }] },
      makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }),
    );
    expect(closed).toBe(2);
  });

  it('resumes the session on the next scripted turn', async () => {
    const { runQuery, seen } = fakeSdk(() => [
      initMessage([]), assistantMessage([{ type: 'text', text: 'ok' }], 'end_turn'), resultMessage(),
    ]);
    await runCase(
      { ...BASE_CASE, script: [{ kind: 'user', text: 'One.' }, { kind: 'user', text: 'Two.' }] },
      makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }),
    );
    expect(seen[0].resume).toBeUndefined();
    expect(seen[1].resume).toBe('sess-1');
  });

  it('never puts an API key in the subprocess environment', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-travel';
    try {
      const { runQuery, seen } = fakeSdk(() => [
        initMessage([]), assistantMessage([{ type: 'text', text: 'ok' }], 'end_turn'), resultMessage(),
      ]);
      await runCase(BASE_CASE, makeAgentSdkBackend({
        model: 'claude-sonnet-5', oauthToken: 'oat-token', runQuery,
      }));
      expect(seen[0].env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seen[0].env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-token');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('fails the case on the synthetic message a not-logged-in SDK returns', async () => {
    const { runQuery } = fakeSdk(() => [
      initMessage([]),
      { type: 'assistant', message: {
        model: '<synthetic>', stop_reason: 'stop_sequence', usage: {},
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
      } } as unknown as SDKMessage,
    ]);
    await expect(runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery })))
      .rejects.toThrow(AgentSdkBackendError);
    // And specifically NOT scored as something the coach said.
    await expect(runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery })))
      .rejects.toThrow(/Not logged in/);
  });

  it('fails the case on an error result', async () => {
    const { runQuery } = fakeSdk(() => [
      initMessage([]),
      resultMessage({ subtype: 'error_during_execution', is_error: true, result: 'boom' }),
    ]);
    await expect(runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery })))
      .rejects.toThrow(/error_during_execution/);
  });

  it('records a leaked built-in tool as an anomaly', async () => {
    const { runQuery } = fakeSdk(() => [
      initMessage([`${MCP_PREFIX}create_event`, 'Bash', 'Read']),
      assistantMessage([{ type: 'text', text: 'ok' }], 'end_turn'),
      resultMessage(),
    ]);
    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));
    expect(result.anomalies).toEqual(['sdkBuiltinToolsPresent:Bash,Read (turn 1)']);
  });

  it('records max_tokens truncation as an anomaly, as the API backend does', async () => {
    const { runQuery } = fakeSdk(() => [
      initMessage([]),
      assistantMessage([{ type: 'text', text: 'truncated...' }], 'max_tokens'),
      resultMessage({ stop_reason: 'max_tokens' }),
    ]);
    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));
    expect(result.anomalies.some(a => a.includes('max_tokens'))).toBe(true);
  });
});

describe('stripMcpPrefix', () => {
  it('removes the server prefix the SDK puts on the wire, and nothing else', () => {
    expect(stripMcpPrefix(`${MCP_PREFIX}create_event`)).toBe('create_event');
    expect(stripMcpPrefix('create_event')).toBe('create_event');
    expect(stripMcpPrefix('mcp__other__create_event')).toBe('mcp__other__create_event');
  });
});

describe('tokensFromSdkUsage', () => {
  it('counts cached reads as input, so the two backends stay comparable', () => {
    expect(tokensFromSdkUsage({
      input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 20,
    })).toEqual({ inputTokens: 125, outputTokens: 9 });
    expect(tokensFromSdkUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('zodShapeFromJsonSchema', () => {
  it('converts every production coach schema, so schemas.ts stays the source of truth', () => {
    for (const schema of coachToolSchemas()) {
      const shape = zodShapeFromJsonSchema(schema.input_schema);
      const declared = Object.keys(
        (schema.input_schema as { properties: Record<string, unknown> }).properties);
      expect(Object.keys(shape).sort()).toEqual(declared.sort());
    }
  });
});

// ─── Case selection ──────────────────────────────────────────────────────────

describe('selectCases', () => {
  const cases = ['pulley-injury', 'pulley-injury-late', 'deload-week', 'taper'].map(
    id => ({ ...BASE_CASE, id }));

  it('keeps substring semantics for a single value', () => {
    expect(selectCases(cases, 'pulley').map(c => c.id))
      .toEqual(['pulley-injury', 'pulley-injury-late']);
  });

  it('selects a comma-separated list by exact id', () => {
    expect(selectCases(cases, 'pulley-injury,taper').map(c => c.id))
      .toEqual(['pulley-injury', 'taper']);
    // Exact, so the list never drags a neighbour in the way a substring does.
    expect(selectCases(cases, 'pulley-injury, deload-week').map(c => c.id))
      .toEqual(['pulley-injury', 'deload-week']);
  });

  it('returns everything when the filter is empty', () => {
    expect(selectCases(cases, '')).toHaveLength(4);
  });
});
