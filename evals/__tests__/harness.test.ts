import { describe, it, expect } from 'vitest';
import { runCase } from '../src/harness';
import { makeEvent } from '../src/fixtures';
import type { CallModel, EvalCase, ModelResponse } from '../src/types';

// Harness conversation-loop semantics against a scripted fake model:
// confirm-loop mirroring, every-tool-confirmed queue flushing, thinking
// stripped, auto-continue, system prompt rebuilt from mutated state.

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

  it('confirms every parallel tool_use and flushes all results as one message, like actionQueue', async () => {
    const { call } = scriptedModel([
      response([
        toolUse('tu-1', 'create_event', { type: 'weights', title: 'First', date: '2026-08-07', estimated_duration: 60 }),
        toolUse('tu-2', 'create_event', { type: 'weights', title: 'Second', date: '2026-08-08', estimated_duration: 60 }),
      ], 'tool_use'),
      response([text('Done.')]),
    ]);
    const result = await runCase(BASE_CASE, call);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map(c => c.input.title)).toEqual(['First', 'Second']);
    expect(result.finalEvents).toHaveLength(2);
    // One user message carrying a tool_result per tool_use, in order.
    const flush = result.transcript[2];
    expect(flush.role).toBe('user');
    expect((flush.content as Array<{ tool_use_id?: string }>).map(b => b.tool_use_id)).toEqual(['tu-1', 'tu-2']);
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

  it('renders the training block and today\'s meals into the system prompt', async () => {
    const { call, requests } = scriptedModel([response([text('Hi.')])]);
    const evalCase: EvalCase = {
      ...BASE_CASE,
      fixture: {
        today: '2026-08-03', events: [],
        block: {
          name: 'Base Building', intent: 'aerobic base', weekLabel: 'week 2 of 8',
          rangeLabel: 'Jul 27 – Sep 20', objective: null, currentWeek: [], toDate: [],
        },
        meals: [
          { id: 'm1', title: 'Overnight Oats', date: '2026-08-03', notes: '' },
          { id: 'm2', title: 'Last Week Curry', date: '2026-07-28', notes: '' },
        ],
      },
    };
    const result = await runCase(evalCase, call);
    expect(requests[0].system).toContain('Base Building');
    expect(requests[0].system).toContain('Overnight Oats');
    // Only TODAY's meals render, matching ChatSidebar's getMealsForDate(today).
    expect(requests[0].system).not.toContain('Last Week Curry');
    expect(result.finalMeals).toHaveLength(2);
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

describe('planner mode (E01)', () => {
  const PLAN = {
    blocks: [
      { name: 'Base', phase: 'base', start_date: '2026-08-03', end_date: '2026-08-30', weekly_targets: { cardio_minutes: 300 } },
      { name: 'Build', phase: 'build', start_date: '2026-08-31', end_date: '2026-09-27' },
    ],
  };
  const plannerCase: EvalCase = {
    ...BASE_CASE,
    mode: 'planner',
    fixture: {
      today: '2026-08-03', events: [],
      existingBlocks: [{ id: 'blk-0', name: 'Summer', intent: '', startDate: '2026-07-06', endDateExclusive: '2026-08-03', weeklyTargets: {} }],
      objectives: [{ id: 'obj-1', name: 'Denali', notes: '', status: 'active' }],
      reads: { get_training_blocks: { blocks: [{ id: 'blk-0', name: 'Summer' }] } },
    },
    script: [{ kind: 'user', text: 'Plan eight weeks.' }],
  };

  it('reads from the fixture, reduces update_block_draft onto the block draft, and reports the final draft', async () => {
    const { call, requests } = scriptedModel([
      response([text('Checking.'), toolUse('r-1', 'get_training_blocks', {}), toolUse('d-1', 'read_doctrine', { topic: 'periodization' })], 'tool_use'),
      response([text('Here is the plan.'), toolUse('w-1', 'update_block_draft', PLAN)], 'tool_use'),
      response([text('Review it and press Apply.')]),
    ]);
    const result = await runCase(plannerCase, call);

    // The planner's prompt is the split prompt joined: stable half, then the
    // live half with the draft, the existing blocks and the objectives.
    expect(requests[0].system).toContain('helping the user plan TRAINING BLOCKS');
    expect(requests[0].system).toContain('<block_draft>\nCURRENT DRAFT (what update_block_draft replaces):\n(no blocks yet)');
    expect(requests[0].system).toContain('- [blk-0] Summer · 2026-07-06 → 2026-08-02 (4 weeks)');
    expect(requests[0].system).toContain('- [obj-1] Denali · undated · active');
    // The read round was answered in the same turn with tools on; the write
    // was confirmed and the re-stream ran with tools off.
    expect(requests.map(r => r.withTools)).toEqual([true, true, false]);
    // And the live half moved with the draft.
    expect(requests[2].system).toContain('1. Base · phase base · start_date 2026-08-03 · end_date 2026-08-30 (4 weeks)');
    expect(requests[2].system).not.toContain('(no blocks yet)');

    expect(result.toolCalls.map(c => [c.name, c.kind])).toEqual([
      ['get_training_blocks', 'read'], ['read_doctrine', 'read'], ['update_block_draft', 'write'],
    ]);
    expect(result.toolCalls[2].result).toBe('Block draft updated: 2 blocks, Aug 3 – Sep 27 (base 4w · build 4w). The user reviews and presses Apply.');
    expect(result.finalBlockDraft).toEqual({
      editingId: null,
      blocks: [
        { name: 'Base', intent: '', phase: 'base', objectiveId: undefined, startDate: '2026-08-03', endDateExclusive: '2026-08-31', weeklyTargets: { cardioMinutes: 300 } },
        { name: 'Build', intent: '', phase: 'build', objectiveId: undefined, startDate: '2026-08-31', endDateExclusive: '2026-09-28', weeklyTargets: {} },
      ],
    });
    expect(result.finalDraft).toBeUndefined();
    expect(result.anomalies).toEqual([]);
  });

  it('hands the reducer\'s one instructive error back as the tool_result, and flags a tool the mode lacks', async () => {
    const { call } = scriptedModel([
      // Turn 1: the write, then its tools-off settle. Turn 2: a tool the
      // planner lacks, then its settle.
      response([toolUse('w-1', 'update_block_draft', { blocks: [{ name: 'Base', start_date: '2026-07-27', end_date: '2026-08-30' }] })], 'tool_use'),
      response([text('Let me fix the dates.')]),
      response([toolUse('x-1', 'create_event', { title: 'Hike' })], 'tool_use'),
      response([text('Done.')]),
    ]);
    const result = await runCase({ ...plannerCase, script: [{ kind: 'user', text: 'Plan.' }, { kind: 'user', text: 'Schedule a hike.' }] }, call);
    expect(result.toolCalls[0].result).toContain('overlaps the existing block "Summer"');
    expect(result.toolCalls[0].result).toContain("before this week's Monday");
    expect(result.finalBlockDraft?.blocks).toEqual([]);
    expect(result.toolCalls[1]).toMatchObject({ name: 'create_event', result: 'Unknown tool "create_event".' });
    expect(result.anomalies).toEqual(['unknownTool:create_event (turn 2)']);
    expect(result.finalEvents).toEqual([]);
  });
});
