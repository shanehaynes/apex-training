import { describe, it, expect } from 'vitest';
import { runCase } from '../src/harness';
import { makeEvent } from '../src/fixtures';
import type { CallModel, EvalCase, ModelResponse } from '../src/types';

// Harness conversation-loop semantics against a scripted fake model:
// confirm-loop mirroring, last-tool-wins, thinking stripped, auto-continue,
// system prompt rebuilt from mutated state.

function response(blocks: ModelResponse['content'], stopReason = 'end_turn'): ModelResponse {
  return { content: blocks, stopReason, usage: { inputTokens: 100, outputTokens: 50 } };
}

const text = (t: string) => ({ type: 'text', text: t });
const thinking = () => ({ type: 'thinking', thinking: '' });
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input });

function scriptedModel(responses: ModelResponse[]): { call: CallModel; requests: Array<{ system: string; withTools: boolean }> } {
  const requests: Array<{ system: string; withTools: boolean }> = [];
  let i = 0;
  const call: CallModel = async ({ system, withTools }) => {
    requests.push({ system, withTools });
    if (i >= responses.length) throw new Error('fake model ran out of responses');
    return responses[i++];
  };
  return { call, requests };
}

const BASE_CASE: EvalCase = {
  id: 'test-case', description: '',
  fixture: { today: '2026-08-03', events: [] },
  script: [{ kind: 'user', text: 'Create a workout for Friday.' }],
  expect: {},
};

describe('runCase', () => {
  it('mirrors the confirm loop: tools on, execute, tool_result, tools off', async () => {
    const { call, requests } = scriptedModel([
      response([
        thinking(),
        text('Creating it.'),
        toolUse('tu-1', 'create_event', { type: 'weights', title: 'Friday Strength', date: '2026-08-07', estimated_duration: 60 }),
      ], 'tool_use'),
      response([text('Done — Friday Strength is on your calendar.')]),
    ]);

    const result = await runCase(BASE_CASE, call);

    expect(requests.map(r => r.withTools)).toEqual([true, false]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].result).toContain('Created "Friday Strength"');
    expect(result.finalEvents).toHaveLength(1);

    // Transcript: user, assistant(text+tool_use), user(tool_result), assistant(text)
    expect(result.transcript.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const assistantContent = result.transcript[1].content;
    expect(Array.isArray(assistantContent)).toBe(true);
    // Thinking blocks never enter history (wire protocol drops them).
    expect(JSON.stringify(result.transcript)).not.toContain('thinking');
  });

  it('rebuilds the system prompt from mutated state before the follow-up call', async () => {
    const { call, requests } = scriptedModel([
      response([toolUse('tu-1', 'create_event', { type: 'weights', title: 'Friday Strength', date: '2026-08-07', estimated_duration: 60 })], 'tool_use'),
      response([text('Done.')]),
    ]);
    await runCase(BASE_CASE, call);
    expect(requests[0].system).not.toContain('Friday Strength');
    expect(requests[1].system).toContain('Friday Strength');
  });

  it('keeps only the last tool_use and records a multiToolTurn anomaly', async () => {
    const { call } = scriptedModel([
      response([
        toolUse('tu-1', 'create_event', { type: 'weights', title: 'First', date: '2026-08-07', estimated_duration: 60 }),
        toolUse('tu-2', 'create_event', { type: 'weights', title: 'Second', date: '2026-08-08', estimated_duration: 60 }),
      ], 'tool_use'),
      response([text('Done.')]),
    ]);
    const result = await runCase(BASE_CASE, call);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].input.title).toBe('Second');
    expect(result.anomalies.some(a => a.startsWith('multiToolTurn'))).toBe(true);
  });

  it('records max_tokens truncation as an anomaly', async () => {
    const { call } = scriptedModel([response([text('truncated...')], 'max_tokens')]);
    const result = await runCase(BASE_CASE, call);
    expect(result.anomalies.some(a => a.includes('max_tokens'))).toBe(true);
  });

  it('auto-continue repeats while tool calls keep coming, then stops', async () => {
    const mk = (n: number) =>
      toolUse(`tu-${n}`, 'create_event', { type: 'weights', title: `W${n}`, date: `2026-08-0${n}`, estimated_duration: 60 });
    const { call } = scriptedModel([
      response([mk(4)], 'tool_use'), response([text('ok')]),   // turn 1 (user)
      response([mk(5)], 'tool_use'), response([text('ok')]),   // turn 2 (continue)
      response([text('That completes the plan.')]),            // turn 3 (continue, no tool)
    ]);
    const evalCase: EvalCase = {
      ...BASE_CASE,
      script: [
        { kind: 'user', text: 'Plan my week.' },
        { kind: 'auto-continue', max: 5 },
      ],
    };
    const result = await runCase(evalCase, call);
    expect(result.turns).toHaveLength(3);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.finalEvents).toHaveLength(2);
  });

  it('feeds executor validation errors back as the tool_result', async () => {
    const { call } = scriptedModel([
      response([toolUse('tu-1', 'set_event_exercises', {
        event_id: 'evt-1',
        exercises: [{ name: 'Pistol Squats', sets: 3, reps: '5' }],
      })], 'tool_use'),
      response([text('Let me fix that.')]),
    ]);
    const evalCase: EvalCase = {
      ...BASE_CASE,
      fixture: { today: '2026-08-03', events: [makeEvent({ id: 'evt-1', date: '2026-08-03', title: 'Legs' })] },
    };
    const result = await runCase(evalCase, call);
    expect(result.toolCalls[0].result).toContain('Unilateral exercises need per-side counts');
    const toolResultMsg = result.transcript[2];
    expect(Array.isArray(toolResultMsg.content) && (toolResultMsg.content[0] as { content: string }).content)
      .toContain('per-side');
  });

  it('renders athlete context into the system prompt', async () => {
    const { call, requests } = scriptedModel([response([text('Hi.')])]);
    const evalCase: EvalCase = {
      ...BASE_CASE,
      fixture: {
        today: '2026-08-03', events: [],
        athlete: { goal: 'Climb V8', context: 'A2 pulley strain, no crimping' },
      },
    };
    await runCase(evalCase, call);
    expect(requests[0].system).toContain('A2 pulley strain');
    expect(requests[0].system).toContain('Climb V8');
  });
});
