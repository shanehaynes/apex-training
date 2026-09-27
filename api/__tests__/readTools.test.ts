import { describe, it, expect, vi, afterEach } from 'vitest';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import {
  COACH_READ_TOOLS,
  executeReadTool,
  isReadToolName,
  readToolLabel,
  readToolSchemas,
} from '../_lib/coach/readTools';
import { MCP_TOOLS } from '../_lib/mcp/toolRegistry';

// The interface contract the coach loop (api/chat.ts, next wave) imports.
// Order and shape are pinned here because the prompt cache is a prefix
// match over the tool list: a reordered schema is a cache miss on every turn.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const EXPECTED_ORDER = [
  'get_schedule',
  'get_workout_detail',
  'get_exercise_history',
  'get_prs',
  'get_period_stats',
  'get_training_blocks',
  'search_exercises',
  'get_meals',
  'get_session_summaries',
  'get_reviews',
  'search_history',
];

/** A client whose every query rejects — enough for the error paths. */
function brokenAdmin(message: string): Admin {
  return {
    from() {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'eq', 'neq', 'gte', 'lte', 'lt', 'is', 'not', 'in', 'or', 'range', 'limit', 'textSearch']) {
        builder[m] = chain;
      }
      builder.maybeSingle = async () => ({ data: null, error: { message } });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message } }).then(resolve);
      return builder;
    },
    async rpc() {
      return { data: null, error: { message } };
    },
  } as unknown as Admin;
}

describe('COACH_READ_TOOLS / readToolSchemas', () => {
  it('is the MCP tools in registry order, then the history readers, each name once', () => {
    expect(COACH_READ_TOOLS.map(t => t.name)).toEqual(EXPECTED_ORDER);
    for (const tool of MCP_TOOLS) expect(COACH_READ_TOOLS).toContain(tool);
  });

  it('yields one Anthropic.Tool per entry in the same order, identically on every call', () => {
    const first = readToolSchemas();
    const second = readToolSchemas();
    expect(first.map(t => t.name)).toEqual(EXPECTED_ORDER);
    expect(second).toEqual(first);
    first.forEach((schema, i) => {
      const tool = COACH_READ_TOOLS[i];
      expect(schema).toEqual({ name: tool.name, description: tool.description, input_schema: tool.inputSchema });
      expect(schema.input_schema.type).toBe('object');
      expect('strict' in schema).toBe(false);
    });
  });

  it('hands out copies, so a caller adding cache_control cannot bleed into the next turn', () => {
    const tools = readToolSchemas();
    tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    expect('cache_control' in readToolSchemas()[tools.length - 1]).toBe(false);
  });

  it('isReadToolName answers from the same list', () => {
    for (const name of EXPECTED_ORDER) expect(isReadToolName(name)).toBe(true);
    expect(isReadToolName('apply_workout')).toBe(false);
    expect(isReadToolName('')).toBe(false);
  });
});

describe('executeReadTool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a ToolInputError to its message with isError, without throwing', async () => {
    const result = await executeReadTool(brokenAdmin('unused'), 'user-1', 'get_schedule', { start_date: 'nope' });
    expect(result).toEqual({ text: 'start_date must be a YYYY-MM-DD date string.', isError: true });
  });

  it('marks an unknown tool name as an error', async () => {
    const result = await executeReadTool(brokenAdmin('unused'), 'user-1', 'delete_everything', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('delete_everything');
  });

  it('turns any other failure into "tool failed" and logs only the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await executeReadTool(brokenAdmin('secret-key-leak: sk-ant-xyz'), 'user-1', 'get_reviews', {});
    expect(result).toEqual({ text: 'tool failed', isError: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const [prefix, detail] = warn.mock.calls[0];
    expect(prefix).toContain('get_reviews');
    expect(typeof detail).toBe('string');
    expect(detail).not.toMatch(/\n\s+at /); // a message, never a stack
  });

  it('tolerates a non-object input and runs the tool with no arguments', async () => {
    const result = await executeReadTool(brokenAdmin('unused'), 'user-1', 'get_workout_detail', 'garbage');
    expect(result).toEqual({ text: 'event_id must be a non-empty string.', isError: true });
  });

  it('JSON-stringifies a successful payload', async () => {
    const admin = {
      from() {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        for (const m of ['select', 'order', 'eq', 'neq', 'gte', 'lte', 'lt', 'is', 'not', 'in', 'range', 'limit', 'textSearch']) {
          builder[m] = chain;
        }
        builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
        return builder;
      },
    } as unknown as Admin;
    const result = await executeReadTool(admin, 'user-1', 'get_reviews', { kind: 'year' });
    expect(result).toEqual({ text: JSON.stringify({ reviews: [] }), isError: false });
  });
});

describe('readToolLabel', () => {
  it('names what was checked, one line per tool', () => {
    expect(readToolLabel('get_exercise_history', { exercise_name: 'Deadlift' })).toBe('Checked: Deadlift history');
    expect(readToolLabel('get_prs', {})).toBe('Checked: PRs (all time)');
    expect(readToolLabel('get_prs', { scope: 'period', start_date: '2026-06-01', end_date: '2026-08-31' }))
      .toBe('Checked: PRs (2026-06-01 → 2026-08-31)');
    expect(readToolLabel('get_period_stats', { period_type: 'month', year: 2026, month: 8 })).toBe('Checked: stats 2026 month 8');
    expect(readToolLabel('get_period_stats', { period_type: 'year', year: 2025 })).toBe('Checked: stats 2025');
    expect(readToolLabel('get_schedule', {})).toBe('Checked: schedule');
    expect(readToolLabel('get_schedule', { start_date: '2026-08-01', end_date: '2026-08-07' }))
      .toBe('Checked: schedule 2026-08-01 → 2026-08-07');
    expect(readToolLabel('get_workout_detail', { event_id: 'e', date: '2026-08-05' })).toBe('Checked: workout on 2026-08-05');
    expect(readToolLabel('get_training_blocks', { scope: 'all' })).toBe('Checked: training blocks');
    expect(readToolLabel('search_exercises', { query: 'row' })).toBe('Checked: exercise library for "row"');
    expect(readToolLabel('get_meals', { start_date: '2026-08-01', end_date: '2026-08-07' })).toBe('Checked: meals 2026-08-01 → 2026-08-07');
    expect(readToolLabel('get_session_summaries', {})).toBe('Checked: session summaries');
    expect(readToolLabel('get_reviews', { kind: 'month' })).toBe('Checked: monthly reviews');
    expect(readToolLabel('get_reviews', {})).toBe('Checked: reviews');
    expect(readToolLabel('search_history', { query: 'left shoulder' })).toBe('Searched history: "left shoulder"');
  });

  it('never throws: empty, null, non-object and unknown inputs all fall back', () => {
    expect(readToolLabel('get_exercise_history', {})).toBe('Checked: exercise history');
    expect(readToolLabel('search_history', null)).toBe('Searched history');
    expect(readToolLabel('get_prs', undefined)).toBe('Checked: PRs (all time)');
    expect(readToolLabel('get_schedule', 'not an object')).toBe('Checked: schedule');
    expect(readToolLabel('some_future_tool', { anything: 1 })).toBe('Checked: some_future_tool');
    // A poisoned input whose property access throws still yields the fallback.
    const trap = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(readToolLabel('get_exercise_history', trap)).toBe('Checked: get_exercise_history');
  });
});
