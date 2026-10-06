import { describe, it, expect } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { MCP_CONNECTOR_READ_TOOLS, MCP_CONNECTOR_TOOLS, MCP_WRITE_TOOLS } from '../_lib/mcp/connectorRegistry';
import { MCP_TOOLS } from '../_lib/mcp/toolRegistry';
import {
  handleMcpMessage,
  isWriteTool,
  READ_ONLY_CONNECTION_MESSAGE,
  toolAnnotations,
  type McpToolDef,
} from '../_lib/mcp/protocol';
import { normalizeScope, OAUTH_SCOPE, parseScopes, scopeGrantsWrite } from '../_lib/oauth/common';
import { resolveMcpAccess } from '../_lib/mcp/tokens';
import { coachToolSchemas } from '../../src/lib/coach/schemas';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

// The connector's write surface: the registry's invariants, the scope
// helpers that decide who gets it, the dispatcher's guard, and the two
// native tools with the most plumbing (complete_workout, log_workout) over a
// write-capturing mock. The coach-backed tools' executors are the ones
// src/lib/coach/__tests__ and the evals cover; here only their re-cut
// schemas are checked.

describe('connector registry', () => {
  it('names every tool once, reads before writes, with the ten query tools unchanged in front', () => {
    const names = MCP_CONNECTOR_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(0, MCP_TOOLS.length)).toEqual(MCP_TOOLS.map(t => t.name));
    expect(MCP_CONNECTOR_TOOLS.slice(0, MCP_CONNECTOR_READ_TOOLS.length)).toEqual([...MCP_CONNECTOR_READ_TOOLS]);
  });

  it('marks every write tool as such, with a title and a readOnlyHint of false', () => {
    for (const tool of MCP_WRITE_TOOLS) {
      expect(isWriteTool(tool)).toBe(true);
      const annotations = toolAnnotations(tool);
      expect(annotations.readOnlyHint).toBe(false);
      expect(annotations.openWorldHint).toBe(false);
      expect(typeof annotations.title).toBe('string');
      expect(typeof annotations.destructiveHint).toBe('boolean');
      expect((tool.inputSchema as { type: string }).type).toBe('object');
    }
    for (const tool of MCP_CONNECTOR_READ_TOOLS) {
      expect(isWriteTool(tool)).toBe(false);
      expect(toolAnnotations(tool).readOnlyHint).toBe(true);
    }
  });

  it('flags the tools that delete or overwrite as destructive', () => {
    const destructive = MCP_WRITE_TOOLS.filter(t => toolAnnotations(t).destructiveHint).map(t => t.name).sort();
    expect(destructive).toEqual([
      'delete_event', 'delete_meal', 'delete_objective', 'delete_training_block',
      'set_event_exercises', 'uncomplete_workout', 'update_coach_memory',
    ]);
  });

  it('re-cuts every coach mutation schema: card-only fields out, `today` in, prompt phrasing gone', () => {
    const cardOnly = ['event_title', 'event_date_display', 'meal_title', 'target_label', 'reason'];
    for (const schema of coachToolSchemas()) {
      const tool = MCP_WRITE_TOOLS.find(t => t.name === schema.name);
      expect(tool, schema.name).toBeDefined();
      const input = tool!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      for (const field of cardOnly) {
        expect(input.properties, `${schema.name}.${field}`).not.toHaveProperty(field);
        expect(input.required ?? []).not.toContain(field);
      }
      expect(input.properties).toHaveProperty('today');
      const text = JSON.stringify(tool!.inputSchema) + tool!.description;
      expect(text).not.toContain('[brackets]');
      expect(text).not.toContain('EXERCISE LIBRARY');
      expect(text).not.toContain('confirmation card');
      // The coach's own schema is untouched: the chat's prompt cache keys on it.
      expect(JSON.stringify(schema.input_schema)).toContain(schema.name === 'delete_event' ? 'event_title' : 'type');
    }
  });
});

describe('scopes', () => {
  it('keeps only supported scopes, in canonical order, deduped', () => {
    expect(parseScopes('mcp:write mcp:read bogus mcp:write')).toEqual(['mcp:read', 'mcp:write']);
    expect(parseScopes('  mcp:read ')).toEqual(['mcp:read']);
    expect(parseScopes(null)).toEqual([]);
    expect(normalizeScope('bogus')).toBeNull();
    expect(normalizeScope('mcp:write')).toBe('mcp:write');
    expect(normalizeScope(OAUTH_SCOPE)).toBe('mcp:read mcp:write');
  });

  it('grants writes only to a scope that names mcp:write — never to a legacy token with none', () => {
    expect(scopeGrantsWrite(OAUTH_SCOPE)).toBe(true);
    expect(scopeGrantsWrite('mcp:write')).toBe(true);
    expect(scopeGrantsWrite('mcp:read')).toBe(false);
    expect(scopeGrantsWrite(null)).toBe(false);
    expect(scopeGrantsWrite(undefined)).toBe(false);
    expect(scopeGrantsWrite('')).toBe(false);
  });
});

describe('resolveMcpAccess', () => {
  function adminWithToken(row: Record<string, unknown> | null): Admin {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ['select', 'eq', 'is', 'or', 'update']) builder[m] = chain;
    builder.maybeSingle = async () => ({ data: row, error: null });
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
    return { from: () => builder } as unknown as Admin;
  }
  const req = { headers: { authorization: 'Bearer apx_abc' } } as unknown as VercelRequest;

  it('reads write access off the stored scope', async () => {
    const full = await resolveMcpAccess(adminWithToken({ id: 't', user_id: 'user-9', last_used_at: null, scope: 'mcp:read mcp:write' }), req);
    expect(full).toEqual({ userId: 'user-9', canWrite: true });
    const read = await resolveMcpAccess(adminWithToken({ id: 't', user_id: 'user-9', last_used_at: null, scope: 'mcp:read' }), req);
    expect(read).toEqual({ userId: 'user-9', canWrite: false });
  });

  it('keeps a token minted before write access existed (no scope) read-only', async () => {
    const legacy = await resolveMcpAccess(adminWithToken({ id: 't', user_id: 'user-9', last_used_at: null, scope: null }), req);
    expect(legacy).toEqual({ userId: 'user-9', canWrite: false });
  });

  it('answers null for an unknown token', async () => {
    expect(await resolveMcpAccess(adminWithToken(null), req)).toBeNull();
  });
});

describe('dispatcher write guard', () => {
  const ran: string[] = [];
  const readTool: McpToolDef = {
    name: 'read_thing', description: '', inputSchema: { type: 'object' },
    async run() { ran.push('read'); return { ok: true }; },
  };
  const writeTool: McpToolDef = {
    name: 'write_thing', description: '', inputSchema: { type: 'object' }, access: 'write',
    async run() { ran.push('write'); return { ok: true }; },
  };
  const tools = [readTool, writeTool];
  const supabase = {} as Admin;
  const call = (name: string) => ({ jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name, arguments: {} } });
  const resultOf = (outcome: Awaited<ReturnType<typeof handleMcpMessage>>) =>
    (outcome as { body: { result: { isError?: boolean; content: Array<{ text: string }> } } }).body.result;

  it('runs reads for every connection and writes only for a write-capable one', async () => {
    ran.length = 0;
    expect(resultOf(await handleMcpMessage(call('read_thing'), tools, { supabase, userId: 'u', canWrite: false })).isError).toBeUndefined();
    const refused = resultOf(await handleMcpMessage(call('write_thing'), tools, { supabase, userId: 'u', canWrite: false }));
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(READ_ONLY_CONNECTION_MESSAGE);
    expect(resultOf(await handleMcpMessage(call('write_thing'), tools, { supabase, userId: 'u', canWrite: true })).isError).toBeUndefined();
    expect(ran).toEqual(['read', 'write']);
  });

  it('lets beforeWrite refuse a write with its own message, before the tool runs', async () => {
    ran.length = 0;
    const refused = resultOf(await handleMcpMessage(call('write_thing'), tools, {
      supabase, userId: 'u', canWrite: true, beforeWrite: async () => 'cap reached',
    }));
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe('cap reached');
    expect(ran).toEqual([]);
  });
});

// ── complete_workout / log_workout over a write-capturing mock ───────────────

interface Captured {
  table: string;
  op: 'insert' | 'upsert' | 'update' | 'delete';
  payload: unknown;
  opts?: unknown;
}

function makeWritableAdmin(fixtures: Record<string, unknown[]>, captured: Captured[]): Admin {
  return {
    from(table: string) {
      const rows = fixtures[table] ?? [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'lt', 'is', 'or', 'in', 'limit', 'range']) builder[m] = chain;
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.single = async () => ({ data: rows[0] ?? null, error: null });
      for (const op of ['insert', 'upsert', 'update', 'delete'] as const) {
        builder[op] = (payload: unknown, opts?: unknown) => {
          captured.push({ table, op, payload, opts });
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
      return builder;
    },
    async rpc() {
      return { data: [], error: null };
    },
  } as unknown as Admin;
}

const eventRow = {
  id: 'evt-1',
  type: 'weights',
  title: 'Bench Day',
  subtitle: null,
  date: '2026-08-05',
  start_time: null,
  end_time: null,
  estimated_duration: 45,
  description: '',
  warmup: [{ id: 'row-1', name: 'Easy Row', category: 'cardio', duration: '10 min' }],
  exercises: [{ id: 'bench-1', name: 'Bench Press', category: 'strength', sets: 3, reps: '5', weight: '185 lb' }],
  cooldown: [],
  difficulty: 3,
  location: null,
  cover_image_url: null,
  cardio_targets: null,
  climbing_targets: null,
  tags: [],
  equipment: [],
  is_recurring: false,
  recurrence_rule: null,
  recurring_frequency: null,
  recurring_days: null,
  recurring_end_date: null,
};

const tool = (name: string) => MCP_WRITE_TOOLS.find(t => t.name === name)!;

describe('complete_workout', () => {
  it('records the completion and logs the plan at its targets, autofilled', async () => {
    const captured: Captured[] = [];
    const admin = makeWritableAdmin({ workout_events: [eventRow], exercise_definitions: [] }, captured);
    const result = await tool('complete_workout').run(admin, 'user-123', { event_id: 'evt-1', date: '2026-08-05' }) as { ok: boolean };
    expect(result.ok).toBe(true);

    const completion = captured.find(c => c.table === 'workout_completions');
    expect(completion?.payload).toMatchObject({ event_id: 'evt-1', event_date: '2026-08-05', is_completed: true, user_id: 'user-123' });
    const sets = captured.find(c => c.table === 'workout_set_logs');
    expect(sets?.op).toBe('upsert');
    expect(sets?.opts).toMatchObject({ ignoreDuplicates: true });
    const rows = sets?.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ exercise_name: 'Bench Press', set_number: 1, actual_weight: '185 lb', actual_reps: '5', is_autofilled: true, user_id: 'user-123' });
    const cardio = captured.find(c => c.table === 'workout_cardio_logs');
    expect(cardio).toBeDefined();
    expect((cardio!.payload as Array<Record<string, unknown>>)[0]).toMatchObject({ exercise_name: 'Easy Row', duration_minutes: 10, is_autofilled: true });
  });

  it('refuses an event the user does not own as an input error', async () => {
    const admin = makeWritableAdmin({ workout_events: [], exercise_definitions: [] }, []);
    await expect(tool('complete_workout').run(admin, 'user-123', { event_id: 'nope', date: '2026-08-05' }))
      .rejects.toThrow(/No workout with event_id/);
  });
});

describe('log_workout', () => {
  it('writes hand-entered sets against the plan, numbers them, and finishes with the rest as planned', async () => {
    const captured: Captured[] = [];
    const admin = makeWritableAdmin({ workout_events: [eventRow], exercise_definitions: [] }, captured);
    const result = await tool('log_workout').run(admin, 'user-123', {
      event_id: 'evt-1',
      date: '2026-08-05',
      sets: [
        { exercise: 'bench press', weight: '185 lb', reps: '5' },
        { exercise: 'Bench Press', weight: '190 lb', reps: 4 },
      ],
      cardio: [{ exercise: 'Easy Row', duration_minutes: 12, avg_heart_rate: 130 }],
      duration_minutes: 50,
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, logged_sets: 2, logged_cardio: 1, finished: true });

    const setWrites = captured.filter(c => c.table === 'workout_set_logs' && c.op === 'upsert');
    // First the hand-entered rows (overwriting), then the quick-complete fill (ignoring duplicates).
    expect(setWrites).toHaveLength(2);
    const hand = setWrites[0].payload as Array<Record<string, unknown>>;
    expect(setWrites[0].opts).toEqual({ onConflict: 'user_id,event_id,event_date,section,exercise_id,set_number' });
    expect(hand).toHaveLength(2);
    expect(hand[0]).toMatchObject({
      section: 'exercise', exercise_id: 'bench-1', exercise_name: 'Bench Press', set_number: 1,
      planned_weight: '185 lb', planned_reps: '5', actual_weight: '185 lb', actual_reps: '5', is_autofilled: false, user_id: 'user-123',
    });
    expect(hand[1]).toMatchObject({ set_number: 2, actual_weight: '190 lb', actual_reps: '4', is_autofilled: false });
    expect(setWrites[1].opts).toMatchObject({ ignoreDuplicates: true });

    const cardio = captured.filter(c => c.table === 'workout_cardio_logs' && c.op === 'upsert');
    expect((cardio[0].payload as Array<Record<string, unknown>>)[0]).toMatchObject({
      section: 'warmup', exercise_name: 'Easy Row', duration_minutes: 12, avg_heart_rate: 130, is_autofilled: false,
    });

    // The quick-complete fill stamps the planned duration on an unfinished
    // session first; the explicit finish that follows writes the stated one.
    const finish = captured.filter(c => c.table === 'workout_sessions' && c.op === 'update').at(-1);
    expect(finish?.payload).toMatchObject({ total_duration_seconds: 3000 });
    expect(captured.find(c => c.table === 'workout_completions')?.payload).toMatchObject({ is_completed: true });
  });

  it('zero-fills unlogged planned sets when told they were skipped', async () => {
    const captured: Captured[] = [];
    const admin = makeWritableAdmin({ workout_events: [eventRow], exercise_definitions: [] }, captured);
    await tool('log_workout').run(admin, 'user-123', {
      event_id: 'evt-1', date: '2026-08-05',
      sets: [{ exercise: 'Bench Press', set_number: 1, weight: '185 lb', reps: '5' }],
      unlogged_sets: 'skipped',
    });
    const setWrites = captured.filter(c => c.table === 'workout_set_logs' && c.op === 'upsert');
    const fill = setWrites[1].payload as Array<Record<string, unknown>>;
    expect(setWrites[1].opts).toMatchObject({ ignoreDuplicates: true });
    expect(fill.map(r => r.set_number)).toEqual([1, 2, 3]);
    expect(fill[2]).toMatchObject({ actual_weight: '0', actual_reps: '0', is_autofilled: true });
    // No quick-complete fill at targets on this path.
    expect(captured.filter(c => c.table === 'workout_cardio_logs')).toHaveLength(0);
  });

  it('saves partial logs without finishing when finish is false', async () => {
    const captured: Captured[] = [];
    const admin = makeWritableAdmin({ workout_events: [eventRow], exercise_definitions: [] }, captured);
    const result = await tool('log_workout').run(admin, 'user-123', {
      event_id: 'evt-1', date: '2026-08-05', finish: false,
      sets: [{ exercise: 'Bench Press', weight: '185 lb', reps: '5' }],
    }) as Record<string, unknown>;
    expect(result.finished).toBe(false);
    expect(captured.filter(c => c.table === 'workout_set_logs')).toHaveLength(1);
    expect(captured.find(c => c.table === 'workout_completions')).toBeUndefined();
    expect(captured.find(c => c.table === 'workout_sessions' && c.op === 'update')).toBeUndefined();
  });

  it('refuses an exercise that is not on the plan, naming what is, before writing anything', async () => {
    const captured: Captured[] = [];
    const admin = makeWritableAdmin({ workout_events: [eventRow], exercise_definitions: [] }, captured);
    await expect(tool('log_workout').run(admin, 'user-123', {
      event_id: 'evt-1', date: '2026-08-05', sets: [{ exercise: 'Squat', weight: '225', reps: '5' }],
    })).rejects.toThrow(/not on this workout's plan.*Bench Press/);
    await expect(tool('log_workout').run(admin, 'user-123', {
      event_id: 'evt-1', date: '2026-08-05', sets: [{ exercise: 'Easy Row', duration: '10 min' }],
    })).rejects.toThrow(/is cardio/);
    await expect(tool('log_workout').run(admin, 'user-123', {
      event_id: 'evt-1', date: '2026-08-05', sets: [{ exercise: 'Bench Press' }],
    })).rejects.toThrow(/at least one of weight, reps or duration/);
    expect(captured).toHaveLength(0);
  });
});
