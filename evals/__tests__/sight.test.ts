import { describe, it, expect } from 'vitest';
import type { Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { runCase } from '../src/harness';
import { makeApiBackend } from '../src/backends/api';
import { MCP_PREFIX, makeAgentSdkBackend } from '../src/backends/agentSdk';
import { MAX_SERVER_ROUNDS, UNSCRIPTED_READ_RESULT } from '../src/reads';
import { makeEvent, makePhysiology } from '../src/fixtures';
import { checkIntegrity } from '../src/checkers/integrity';
import { checkDoctrine, weekMinutes } from '../src/checkers/doctrine';
import { renderTranscript } from '../src/judge/refusal';
import { buildRunResult } from '../src/report';
import { readDoctrine } from '../../src/lib/coach/doctrine/index';
import { ALL_CASES } from '../cases/index';
import { DOCTRINE_CASES } from '../cases/doctrine';
import { SIGHT_CASES } from '../cases/sight';
import type { CallModel, CaseResult, EvalCase, HarnessResult, ModelResponse, RecordedToolCall } from '../src/types';

// The sight loop in the harness: a scripted CallModel asks for reads, the
// fixture answers them, and the transcript, the tool record and the anomaly
// list come out the way api/chat.ts + useChat.ts would store them. No live
// model anywhere in this file.

const response = (blocks: ModelResponse['content'], stopReason = 'end_turn'): ModelResponse =>
  ({ content: blocks, stopReason, usage: { inputTokens: 100, outputTokens: 50 } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const read = (id: string, name: string, input: Record<string, unknown> = {}) => toolUse(id, name, input);

function scriptedModel(responses: ModelResponse[]) {
  const requests: Array<{ system: string; withTools: boolean; messages: unknown[] }> = [];
  let i = 0;
  const call: CallModel = async ({ system, withTools, messages }) => {
    requests.push({ system, withTools, messages: JSON.parse(JSON.stringify(messages)) });
    if (i >= responses.length) throw new Error('fake model ran out of responses');
    return responses[i++];
  };
  return { call, requests };
}

const EVENT_INPUT = { type: 'weights', title: 'Friday Strength', date: '2026-08-07', estimated_duration: 60 };

const BASE_CASE: EvalCase = {
  id: 'test-case', description: '',
  fixture: {
    today: '2026-08-03',
    events: [makeEvent({ id: 'evt-1', date: '2026-08-04', title: 'Easy Run', type: 'cardio', estimatedDuration: 60 })],
    reads: {
      get_exercise_history: (input) => ({ canonical_name: input.exercise_name, trend: [{ date: '2026-07-30', value: 356 }] }),
      get_period_stats: { cardio: { minutes: 195 } },
    },
  },
  script: [{ kind: 'user', text: 'How is my deadlift trending?' }],
  expect: {},
};

const tuple = (msgs: unknown[]) => (msgs as Array<{ role: string; content: unknown }>).map(m => m.role);

describe('API backend — read rounds', () => {
  it('answers a read-only round in the same turn and calls again with tools ON', async () => {
    const { call, requests } = scriptedModel([
      response([text('Let me check.'), read('r-1', 'get_exercise_history', { exercise_name: 'Deadlift' })], 'tool_use'),
      response([text('Up 12% since June.')]),
    ]);
    const result = await runCase(BASE_CASE, makeApiBackend(call));

    // Both calls carry tools: there is no tools-off re-stream after a read.
    expect(requests.map(r => r.withTools)).toEqual([true, true]);
    // assistant(text + tool_use) → user(tool_result) → assistant(text)
    expect(tuple(result.transcript)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const resultMsg = result.transcript[2].content as Array<{ type: string; tool_use_id: string; content: unknown }>;
    expect(resultMsg).toEqual([{
      type: 'tool_result', tool_use_id: 'r-1',
      content: JSON.stringify({ canonical_name: 'Deadlift', trend: [{ date: '2026-07-30', value: 356 }] }),
    }]);
    // The second call saw the answered round.
    expect(tuple(requests[1].messages)).toEqual(['user', 'assistant', 'user']);
    expect(result.transcript[3].content).toBe('Up 12% since June.');

    expect(result.toolCalls).toEqual([{
      name: 'get_exercise_history', input: { exercise_name: 'Deadlift' },
      result: JSON.stringify({ canonical_name: 'Deadlift', trend: [{ date: '2026-07-30', value: 356 }] }),
      turn: 1, kind: 'read',
    }]);
    expect(result.turns[0].assistantText).toBe('Let me check.\nUp 12% since June.');
    expect(result.anomalies).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    // Nothing mutated.
    expect(result.finalEvents).toEqual(BASE_CASE.fixture.events);
  });

  it('runs several read rounds, then stops at MAX_SERVER_ROUNDS without executing the next', async () => {
    const asks = Array.from({ length: MAX_SERVER_ROUNDS + 1 }, (_, i) =>
      response([text(`round ${i + 1}`), read(`r-${i + 1}`, 'get_period_stats', { year: 2026 })], 'tool_use'));
    const { call, requests } = scriptedModel(asks);
    const result = await runCase(BASE_CASE, makeApiBackend(call));

    expect(requests).toHaveLength(MAX_SERVER_ROUNDS + 1);
    expect(requests.every(r => r.withTools)).toBe(true);
    expect(result.toolCalls).toHaveLength(MAX_SERVER_ROUNDS);
    expect(result.anomalies).toEqual([`serverRoundCap:${MAX_SERVER_ROUNDS} (turn 1)`]);
    // The capped response is stored as text only — no dangling tool_use.
    const last = result.transcript[result.transcript.length - 1];
    expect(last).toEqual({ role: 'assistant', content: `round ${MAX_SERVER_ROUNDS + 1}` });
    expect(JSON.stringify(result.transcript)).not.toContain(`r-${MAX_SERVER_ROUNDS + 1}`);
    // Every executed round is an assistant/user pair after the opening user message.
    expect(result.transcript).toHaveLength(1 + 2 * MAX_SERVER_ROUNDS + 1);
  });

  it('folds a mixed round: read results lead the one tool_result message, then the confirm path runs', async () => {
    const { call, requests } = scriptedModel([
      response([
        toolUse('w-1', 'create_event', EVENT_INPUT),
        read('r-1', 'get_period_stats'),
      ], 'tool_use'),
      response([text('Scheduled and checked.')]),
    ]);
    const result = await runCase(BASE_CASE, makeApiBackend(call));

    // Tools on, then the tools-off re-stream — a mixed round ends the turn.
    expect(requests.map(r => r.withTools)).toEqual([true, false]);
    expect(tuple(result.transcript)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const results = result.transcript[2].content as Array<{ tool_use_id: string; content: string }>;
    // The read's result is first even though the write was emitted first
    // (useChat holds read results and the confirm flush follows them).
    expect(results.map(r => r.tool_use_id)).toEqual(['r-1', 'w-1']);
    expect(results[0].content).toBe('{"cardio":{"minutes":195}}');
    expect(results[1].content).toContain('Created "Friday Strength"');
    expect(result.toolCalls.map(c => [c.name, c.kind])).toEqual([
      ['get_period_stats', 'read'], ['create_event', 'write'],
    ]);
    expect(result.finalEvents).toHaveLength(2);
  });

  it('answers an unscripted read with the fixed empty result and an anomaly', async () => {
    const { call } = scriptedModel([
      response([read('r-1', 'get_meals', { start_date: '2026-08-01', end_date: '2026-08-03' })], 'tool_use'),
      response([text('No meals logged.')]),
    ]);
    const result = await runCase(BASE_CASE, makeApiBackend(call));
    expect(result.anomalies).toEqual(['unscriptedRead:get_meals']);
    expect(result.toolCalls[0].result).toBe(JSON.stringify(UNSCRIPTED_READ_RESULT));
  });

  it('hands read_doctrine the real topic as a citable document block', async () => {
    const { call } = scriptedModel([
      response([read('r-1', 'read_doctrine', { topic: 'strength' })], 'tool_use'),
      response([text('Heavy, low-rep, twice a week.')]),
    ]);
    const result = await runCase(BASE_CASE, makeApiBackend(call));
    const topic = readDoctrine('strength')!;
    expect(result.toolCalls[0]).toMatchObject({ name: 'read_doctrine', kind: 'read', result: topic });
    const block = (result.transcript[2].content as Array<{ content: unknown }>)[0].content as Array<Record<string, unknown>>;
    expect(block[0]).toMatchObject({ type: 'document', citations: { enabled: true }, title: 'Strength for the mountain athlete' });
    expect((block[0].source as { data: string }).data).toBe(topic);
  });

  it('marks a bad doctrine topic is_error, as production does', async () => {
    const { call } = scriptedModel([
      response([read('r-1', 'read_doctrine', { topic: 'nope' })], 'tool_use'),
      response([text('ok')]),
    ]);
    const result = await runCase(BASE_CASE, makeApiBackend(call));
    const block = (result.transcript[2].content as Array<Record<string, unknown>>)[0];
    expect(block).toEqual({ type: 'tool_result', tool_use_id: 'r-1', content: 'Unknown doctrine topic: nope', is_error: true });
  });

  it('does not auto-continue after a turn that only read', async () => {
    const { call, requests } = scriptedModel([
      response([read('r-1', 'get_period_stats')], 'tool_use'),
      response([text('Here is the answer.')]),
    ]);
    const result = await runCase(
      { ...BASE_CASE, script: [{ kind: 'user', text: 'Stats?' }, { kind: 'auto-continue', max: 3 }] },
      makeApiBackend(call),
    );
    expect(result.turns).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it('treats every tool_use as a write in builder mode, where no read tool exists', async () => {
    const { call, requests } = scriptedModel([
      response([toolUse('t-1', 'get_period_stats', {})], 'tool_use'),
      response([text('ok')]),
    ]);
    const result = await runCase(
      { ...BASE_CASE, mode: 'builder', fixture: { today: '2026-08-03', events: [] } },
      makeApiBackend(call),
    );
    expect(requests.map(r => r.withTools)).toEqual([true, false]);
    expect(result.anomalies).toEqual(['unknownTool:get_period_stats (turn 1)']);
    expect(result.toolCalls[0].kind).toBe('write');
  });

  it('renders the physiology panel into the system prompt when the fixture supplies inputs', async () => {
    const { call, requests } = scriptedModel([response([text('Hi.')])]);
    const withPanel: EvalCase = {
      ...BASE_CASE,
      fixture: {
        ...BASE_CASE.fixture,
        // Two Z2 sessions last week against a 160 threshold.
        physiology: makePhysiology('1999-01-01', [
          { date: '2026-07-28', minutes: 60, avgHr: 140 },
          { date: '2026-07-30', minutes: 45, avgHr: 141 },
        ]),
      },
    };
    await runCase(withPanel, makeApiBackend(call));
    expect(requests[0].system).toContain('<physiology>');
    // The fixture's clock wins over the inputs' own `today`: the week legend
    // ends on the case date, and the sessions land in W-1.
    expect(requests[0].system).toContain('through Aug 3');
    expect(requests[0].system).toMatch(/W-1: 0\/105\/0\/0\/0/);

    const { call: bare, requests: bareRequests } = scriptedModel([response([text('Hi.')])]);
    await runCase(BASE_CASE, makeApiBackend(bare));
    expect(bareRequests[0].system).not.toContain('<physiology>');
  });
});

// ─── Agent SDK backend ───────────────────────────────────────────────────────

type FakeTools = Array<SdkMcpToolDefinition<never>>;

const initMessage = (tools: string[] = []) =>
  ({ type: 'system', subtype: 'init', session_id: 'sess-1', tools } as unknown as SDKMessage);
const assistantMessage = (content: unknown[], stopReason: string | null = null) =>
  ({ type: 'assistant', message: { model: 'claude-sonnet-5', content, stop_reason: stopReason, usage: {} } } as unknown as SDKMessage);
const resultMessage = () =>
  ({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', stop_reason: 'end_turn',
     usage: { input_tokens: 10, output_tokens: 7 } } as unknown as SDKMessage);
const toolResultMessage = (blocks: Array<{ tool_use_id: string; text: string }>) =>
  ({ type: 'user', message: { content: blocks.map(b => ({
    type: 'tool_result', tool_use_id: b.tool_use_id, content: [{ type: 'text', text: b.text }],
  })) } } as unknown as SDKMessage);

async function callTool(tools: FakeTools, name: string, input: Record<string, unknown>) {
  const def = tools.find(t => t.name === name);
  if (!def) throw new Error(`fake SDK: no tool ${name}`);
  const out = await (def as unknown as {
    handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  }).handler(input, {});
  return { text: out.content.map(c => c.text).join(''), isError: out.isError };
}

describe('Agent SDK backend — read tools', () => {
  it('registers the read tools and read_doctrine as SDK tools backed by the fixture', async () => {
    let registered: string[] = [];
    const runQuery = ({ tools }: { prompt: string; options: Options; tools: FakeTools }) => {
      registered = tools.map(t => t.name);
      return (async function* () {
        yield initMessage();
        yield assistantMessage([
          { type: 'tool_use', id: 'r-1', name: `${MCP_PREFIX}get_exercise_history`, input: { exercise_name: 'Deadlift' } },
        ]);
        const history = await callTool(tools, 'get_exercise_history', { exercise_name: 'Deadlift' });
        yield toolResultMessage([{ tool_use_id: 'r-1', text: history.text }]);
        yield assistantMessage([
          { type: 'tool_use', id: 'r-2', name: `${MCP_PREFIX}read_doctrine`, input: { topic: 'strength' } },
        ]);
        const doctrine = await callTool(tools, 'read_doctrine', { topic: 'strength' });
        yield toolResultMessage([{ tool_use_id: 'r-2', text: doctrine.text }]);
        yield assistantMessage([{ type: 'text', text: 'Trending up.' }], 'end_turn');
        yield resultMessage();
      })();
    };
    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));

    expect(registered).toContain('get_exercise_history');
    expect(registered).toContain('read_doctrine');
    expect(registered).toContain('create_event');
    expect(result.toolCalls.map(c => [c.name, c.kind])).toEqual([
      ['get_exercise_history', 'read'], ['read_doctrine', 'read'],
    ]);
    expect(JSON.parse(result.toolCalls[0].result)).toEqual({ canonical_name: 'Deadlift', trend: [{ date: '2026-07-30', value: 356 }] });
    // Text only on this backend — an MCP result cannot carry a document block.
    expect(result.toolCalls[1].result).toBe(readDoctrine('strength'));
    expect(tuple(result.transcript)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(result.anomalies).toEqual([]);
    expect(result.finalEvents).toEqual(BASE_CASE.fixture.events);
  });

  it('flags an error read as isError for the SDK and records the unscripted anomaly', async () => {
    const runQuery = ({ tools }: { prompt: string; options: Options; tools: FakeTools }) =>
      (async function* () {
        yield initMessage();
        const bad = await callTool(tools, 'read_doctrine', { topic: 'nope' });
        expect(bad).toEqual({ text: 'Unknown doctrine topic: nope', isError: true });
        const empty = await callTool(tools, 'get_prs', {});
        expect(empty).toEqual({ text: JSON.stringify(UNSCRIPTED_READ_RESULT), isError: undefined });
        yield assistantMessage([{ type: 'text', text: 'ok' }], 'end_turn');
        yield resultMessage();
      })();
    const result = await runCase(BASE_CASE, makeAgentSdkBackend({ model: 'claude-sonnet-5', runQuery }));
    expect(result.anomalies).toEqual(['unscriptedRead:get_prs']);
  });
});

// ─── Checkers ────────────────────────────────────────────────────────────────

function harnessWith(toolCalls: RecordedToolCall[], finalEvents = BASE_CASE.fixture.events): HarnessResult {
  return {
    transcript: [], turns: [{ userText: 'q', assistantText: 'a', stopReason: 'end_turn', latencyMs: 0 }],
    toolCalls, finalEvents, finalDefinitions: [], finalMeals: [], createdDefinitionNames: [],
    anomalies: [], usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0,
  };
}
const readCall = (name: string, input: Record<string, unknown> = {}, turn = 1): RecordedToolCall =>
  ({ name, input, result: '{}', turn, kind: 'read' });
const writeCall = (name: string, input: Record<string, unknown>, turn = 1): RecordedToolCall =>
  ({ name, input, result: 'ok', turn, kind: 'write' });

describe('checkIntegrity — reads', () => {
  it('accepts any of several names for requireToolCall, reads included', () => {
    const c: EvalCase = { ...BASE_CASE, expect: { integrity: { requireToolCall: { name: ['get_period_stats', 'get_exercise_history'] } } } };
    expect(checkIntegrity(c, harnessWith([readCall('get_exercise_history')])).status).toBe('pass');
    const miss = checkIntegrity(c, harnessWith([readCall('get_schedule')]));
    expect(miss.status).toBe('fail');
    expect(miss.detail[0]).toContain('"get_period_stats" or "get_exercise_history"');
  });

  it('fixtureUnchanged fails on any mutation and passes on none', () => {
    const c: EvalCase = { ...BASE_CASE, expect: { integrity: { fixtureUnchanged: true } } };
    expect(checkIntegrity(c, harnessWith([readCall('get_schedule')])).status).toBe('pass');
    const changed = [{ ...BASE_CASE.fixture.events[0], estimatedDuration: 61 }];
    expect(checkIntegrity(c, harnessWith([], changed)).status).toBe('fail');
    expect(checkIntegrity(c, harnessWith([], [])).status).toBe('fail');
  });

  it('forbidToolCalls sees reads too', () => {
    const c: EvalCase = { ...BASE_CASE, expect: { integrity: { forbidToolCalls: ['search_history'] } } };
    expect(checkIntegrity(c, harnessWith([readCall('search_history')])).status).toBe('fail');
  });
});

describe('checkDoctrine', () => {
  const docCase = (doctrine: NonNullable<EvalCase['expect']['doctrine']>): EvalCase => ({ ...BASE_CASE, expect: { doctrine } });

  it('bans patterns anywhere in an event write, case-insensitively', () => {
    const c = docCase({ bannedEventPatterns: ['vo2', 'hiit'] });
    const clean = checkDoctrine(c, harnessWith([writeCall('create_event', { title: 'Easy Run', description: 'Z2, nasal breathing' })]));
    expect(clean.status).toBe('pass');
    const dirty = checkDoctrine(c, harnessWith([
      writeCall('create_event', { title: 'Aerobic Session', exercises: [{ name: 'Run', notes: 'VO2 max repeats' }] }),
    ]));
    expect(dirty.status).toBe('fail');
    expect(dirty.detail[0]).toContain('BANNED PATTERN');
    // A read that mentions the word is not a write, and does not count.
    expect(checkDoctrine(c, harnessWith([readCall('search_history', { query: 'vo2' })])).status).toBe('pass');
  });

  it('requires a doctrine read, optionally on given topics and before the first write', () => {
    const any = docCase({ requireDoctrineRead: {} });
    expect(checkDoctrine(any, harnessWith([])).status).toBe('fail');
    expect(checkDoctrine(any, harnessWith([readCall('read_doctrine', { topic: 'recovery' })])).status).toBe('pass');

    const topics = docCase({ requireDoctrineRead: { topics: ['strength'] } });
    const wrong = checkDoctrine(topics, harnessWith([readCall('read_doctrine', { topic: 'recovery' })]));
    expect(wrong.status).toBe('fail');
    expect(wrong.detail[0]).toContain('read recovery instead');
    expect(checkDoctrine(topics, harnessWith([readCall('read_doctrine', { topic: 'strength' })])).status).toBe('pass');

    const first = docCase({ requireDoctrineRead: { beforeFirstWrite: true } });
    expect(checkDoctrine(first, harnessWith([
      readCall('read_doctrine', { topic: 'strength' }), writeCall('create_event', EVENT_INPUT),
    ])).status).toBe('pass');
    const late = checkDoctrine(first, harnessWith([
      writeCall('create_event', EVENT_INPUT), readCall('read_doctrine', { topic: 'strength' }),
    ]));
    expect(late.status).toBe('fail');
    expect(late.detail.join('\n')).toContain('PRESCRIBED BEFORE READING');
  });

  it('taperBelowPriorWeek compares planned minutes in today\'s week to the week before', () => {
    const prior = [
      makeEvent({ date: '2026-07-28', title: 'A', estimatedDuration: 200 }),
      makeEvent({ date: '2026-08-01', title: 'B', estimatedDuration: 300 }),
    ];
    expect(weekMinutes([...prior, makeEvent({ date: '2026-08-05', title: 'C', estimatedDuration: 250 })], '2026-08-03'))
      .toEqual({ prior: 500, current: 250, priorStart: '2026-07-27', currentStart: '2026-08-03' });

    const c = docCase({ taperBelowPriorWeek: true });
    expect(checkDoctrine(c, harnessWith([], [...prior, makeEvent({ date: '2026-08-05', title: 'C', estimatedDuration: 250 })])).status).toBe('pass');
    const heavier = checkDoctrine(c, harnessWith([], [...prior, makeEvent({ date: '2026-08-08', title: 'C', estimatedDuration: 500 })]));
    expect(heavier.status).toBe('fail');
    expect(heavier.detail.join('\n')).toContain('TAPER VIOLATION');
    // Nothing planned is not a taper, and a fixture without a prior week is a case bug.
    expect(checkDoctrine(c, harnessWith([], prior)).detail.join('\n')).toContain('NOTHING PLANNED');
    expect(checkDoctrine(c, harnessWith([], [makeEvent({ date: '2026-08-05', title: 'C', estimatedDuration: 10 })])).detail.join('\n'))
      .toContain('NO PRIOR WEEK');
  });

  it('skips when the case has no doctrine expectation', () => {
    expect(checkDoctrine(BASE_CASE, harnessWith([])).status).toBe('skipped');
  });
});

describe('renderTranscript — reads', () => {
  it('shows a data read compactly and a doctrine read by topic, never its text', () => {
    const long = 'x'.repeat(1000);
    const rendered = renderTranscript(harnessWith([
      { name: 'get_period_stats', input: { year: 2026 }, result: long, turn: 1, kind: 'read' },
      { name: 'read_doctrine', input: { topic: 'strength' }, result: readDoctrine('strength')!, turn: 1, kind: 'read' },
      writeCall('create_event', EVENT_INPUT),
    ]));
    expect(rendered).toContain('[coach read "get_period_stats" {"year":2026} → ');
    expect(rendered).not.toContain(long);
    expect(rendered).toContain('[coach read doctrine topic "strength"]');
    expect(rendered).not.toContain('Max strength raises the force ceiling');
    expect(rendered).toContain('[coach proposed and executed tool "create_event": Friday Strength → ok]');
  });
});

describe('report — reads and the doctrine dimension', () => {
  it('aggregates doctrine verdicts like any other dimension', () => {
    const c = (id: string, status: 'pass' | 'fail'): CaseResult => ({
      id, verdicts: { doctrine: { status, detail: [] } }, turns: 1, toolCallCount: 2, readCallCount: 1,
      anomalies: [], usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, latencyMs: 1, transcriptHash: 'h', transcriptPath: 'p',
    });
    const run = buildRunResult('claude-sonnet-5', 'claude-sonnet-5', 'api', [c('a', 'pass'), c('b', 'fail')]);
    expect(run.aggregate.passRateByDimension.doctrine).toEqual({ pass: 1, fail: 1, other: 0 });
    expect(run.cases[0].readCallCount).toBe(1);
  });
});

describe('the sight and doctrine cases', () => {
  it('are registered, and every scripted read is a real read tool name', () => {
    const ids = new Set(ALL_CASES.map(c => c.id));
    for (const c of [...SIGHT_CASES, ...DOCTRINE_CASES]) {
      expect(ids.has(c.id), c.id).toBe(true);
      for (const name of Object.keys(c.fixture.reads ?? {})) {
        expect(name, `${c.id} scripts ${name}`).not.toBe('read_doctrine');
        expect(executeServerSideToolName(name), `${c.id} scripts ${name}`).toBe(true);
      }
    }
    expect(SIGHT_CASES.length + DOCTRINE_CASES.length).toBeGreaterThanOrEqual(6);
    expect(SIGHT_CASES.length + DOCTRINE_CASES.length).toBeLessThanOrEqual(10);
  });

  it('script their reads from the fixture without throwing on a plausible input', () => {
    for (const c of SIGHT_CASES) {
      for (const [name, script] of Object.entries(c.fixture.reads ?? {})) {
        if (typeof script !== 'function') continue;
        const input = name === 'get_exercise_history' ? { exercise_name: 'Deadlift' }
          : name === 'get_schedule' ? { start_date: '2026-07-27', end_date: '2026-08-09' }
          : { period_type: 'month', year: 2026, month: 8 };
        expect(() => JSON.stringify(script(input)), `${c.id}/${name}`).not.toThrow();
      }
    }
  });

  it('banned-pattern lists catch the prescriptions they are written for and spare the doctrine\'s own', () => {
    const base = DOCTRINE_CASES.find(c => c.id === 'doctrine-base-no-intervals')!;
    const me = DOCTRINE_CASES.find(c => c.id === 'doctrine-no-me-before-strength')!;
    // A doctrine read precedes the write so the me case's read requirement
    // is met and only the banned patterns decide.
    const verdict = (c: EvalCase, input: Record<string, unknown>) =>
      checkDoctrine(c, harnessWith([readCall('read_doctrine', { topic: 'strength' }), writeCall('create_event', input)])).status;

    expect(verdict(base, { title: 'VO2 Max Intervals', date: '2026-08-05' })).toBe('fail');
    expect(verdict(base, { title: 'Run', description: '6x3 min hard, 3 min jog' })).toBe('fail');
    expect(verdict(base, { title: 'Easy Hike', description: 'Nasal breathing, below AeT, 75 min' })).toBe('pass');
    expect(verdict(base, { title: 'Long Hike', description: 'Light pack, 3 h, 2,000 ft' })).toBe('pass');

    expect(verdict(me, { title: 'Muscular Endurance — Step-Ups', date: '2026-08-05' })).toBe('fail');
    expect(verdict(me, { title: 'Strength', exercises: [{ name: 'Step-Ups', notes: 'with the 40 lb pack, 20 min continuous' }] })).toBe('fail');
    expect(verdict(me, { title: 'Hill Repeats', date: '2026-08-05' })).toBe('fail');
    expect(verdict(me, { title: 'General Strength', exercises: [
      { name: 'Step-Ups', sets: 3, reps: '10 each leg' }, { name: 'Goblet Squat', sets: 3, reps: '8', weight: '40 lb' },
      { name: "Farmer's Carry", sets: 3, duration: '40 m' },
    ] })).toBe('pass');
    expect(verdict(me, { title: 'Long Hike', description: 'Light pack, easy, 2.5 h' })).toBe('pass');
  });
});

function executeServerSideToolName(name: string): boolean {
  return ['get_schedule', 'get_workout_detail', 'get_exercise_history', 'get_prs', 'get_period_stats',
    'get_training_blocks', 'search_exercises', 'get_meals', 'get_session_summaries', 'get_reviews', 'search_history']
    .includes(name);
}
