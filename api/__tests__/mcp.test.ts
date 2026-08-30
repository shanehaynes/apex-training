import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/mcp';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { resolveMcpToken } from '../_lib/mcp/tokens';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../_lib/mcp/protocol';
import { MCP_TOOLS } from '../_lib/mcp/toolRegistry';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/lib/legal/versions';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/mcp/tokens.js', () => ({ resolveMcpToken: vi.fn(async () => 'user-123') }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedResolve = vi.mocked(resolveMcpToken);

// ── Chainable query mock ──────────────────────────────────────────────────────
// Thenable builder: filter methods record their calls, awaiting resolves with
// the fixture rows for the table (sliced by .range for fetchAllPages).

interface TableCall {
  table: string;
  eq: Record<string, unknown>;
}

// The token owner must have accepted the current terms (handlers/mcp.ts), so
// every fixture set carries a current acceptance unless a test overrides it.
const CURRENT_ACCEPTANCE = {
  terms_version: TERMS_VERSION,
  privacy_version: PRIVACY_VERSION,
  accepted_at: '2026-08-29T00:00:00.000Z',
};

function makeAdmin(fixtures: Record<string, unknown[]>, calls: TableCall[]) {
  return {
    from(table: string) {
      const call: TableCall = { table, eq: {} };
      calls.push(call);
      const rows = fixtures[table] ?? (table === 'terms_acceptances' ? [CURRENT_ACCEPTANCE] : []);
      let from = 0;
      let to = rows.length - 1;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'gte', 'lte', 'lt', 'is', 'or', 'limit']) builder[m] = chain;
      builder.eq = (key: string, value: unknown) => {
        call.eq[key] = value;
        return builder;
      };
      builder.range = (f: number, t: number) => {
        from = f;
        to = t;
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows.slice(from, to + 1), error: null }).then(resolve);
      return builder;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown): VercelRequest {
  return {
    method,
    headers: { authorization: 'Bearer apx_test' },
    body,
    query: {},
  } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    end() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload, headers };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  params,
});

let calls: TableCall[];

beforeEach(() => {
  calls = [];
  mockedResolve.mockResolvedValue('user-123');
  mockedAdmin.mockReturnValue(makeAdmin({}, calls));
});

describe('/api/mcp — transport', () => {
  it('405s non-POST with an Allow header', async () => {
    const { res, statusCode, headers } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(405);
    expect(headers.Allow).toBe('POST');
  });

  it('401s with a WWW-Authenticate challenge carrying OAuth discovery', async () => {
    mockedResolve.mockResolvedValue(null);
    const { res, statusCode, headers } = makeRes();
    await handler(makeReq('POST', rpc('ping')), res);
    expect(statusCode()).toBe(401);
    expect(headers['WWW-Authenticate']).toContain('Bearer');
    expect(headers['WWW-Authenticate']).toContain('resource_metadata=');
    expect(headers['WWW-Authenticate']).toContain('/.well-known/oauth-protected-resource');
  });

  it('rejects JSON-RPC batch arrays (removed in 2025-06-18)', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', [rpc('ping', undefined, 1), rpc('ping', undefined, 2)]), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ error: { code: -32600 } });
  });

  it('parses a string body (charset-suffixed content type path)', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', JSON.stringify(rpc('ping'))), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ id: 1, result: {} });
  });

  it('202s notifications with no body', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', rpc('notifications/initialized', undefined, null)), res);
    expect(statusCode()).toBe(202);
    expect(body()).toBeUndefined();
  });
});

describe('/api/mcp — protocol flow', () => {
  it('initialize negotiates a supported version and advertises tools', async () => {
    const { res, body } = makeRes();
    await handler(makeReq('POST', rpc('initialize', { protocolVersion: '2025-06-18' })), res);
    expect(body()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'apex-training' },
      },
    });
  });

  it('initialize answers an unknown client version with our latest', async () => {
    const { res, body } = makeRes();
    await handler(makeReq('POST', rpc('initialize', { protocolVersion: '2099-01-01' })), res);
    const result = (body() as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('tools/list returns all 8 tools with object input schemas', async () => {
    const { res, body } = makeRes();
    await handler(makeReq('POST', rpc('tools/list')), res);
    const { tools } = (body() as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result;
    expect(tools.map(t => t.name)).toEqual([
      'get_schedule',
      'get_workout_detail',
      'get_exercise_history',
      'get_prs',
      'get_period_stats',
      'get_training_blocks',
      'search_exercises',
      'get_meals',
    ]);
    expect(MCP_TOOLS).toHaveLength(8);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
  });

  it('unknown method → -32601, unknown tool → -32602', async () => {
    const a = makeRes();
    await handler(makeReq('POST', rpc('resources/list')), a.res);
    expect(a.body()).toMatchObject({ error: { code: -32601 } });

    const b = makeRes();
    await handler(makeReq('POST', rpc('tools/call', { name: 'drop_tables' })), b.res);
    expect(b.body()).toMatchObject({ error: { code: -32602 } });
  });
});

describe('/api/mcp — tools/call get_schedule', () => {
  const eventRow = {
    id: 'evt-1',
    type: 'weights',
    title: 'Bench Day',
    subtitle: null,
    date: '2026-08-05',
    start_time: '6:30 AM',
    end_time: null,
    estimated_duration: 60,
    description: '',
    warmup: [],
    exercises: [],
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

  beforeEach(() => {
    mockedAdmin.mockReturnValue(
      makeAdmin(
        {
          workout_events: [eventRow],
          recurring_exceptions: [],
          exercise_definitions: [],
          workout_completions: [
            { event_id: 'evt-1', event_date: '2026-08-05', is_completed: true },
          ],
        },
        calls,
      ),
    );
  });

  it('returns the occurrence with its completion flag, filtering every table by the verified user', async () => {
    const { res, body } = makeRes();
    await handler(
      makeReq('POST', rpc('tools/call', {
        name: 'get_schedule',
        arguments: { start_date: '2026-08-01', end_date: '2026-08-31' },
      })),
      res,
    );
    const result = (body() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as {
      workouts: Array<{ event_id: string; completed: boolean; title: string }>;
    };
    expect(payload.workouts).toEqual([
      expect.objectContaining({ event_id: 'evt-1', title: 'Bench Day', completed: true }),
    ]);
    // Tenancy: every table the tool touched was filtered by the token's user.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.eq.user_id).toBe('user-123');
  });

  it('turns an over-wide range into an isError tool result, not a protocol error', async () => {
    const { res, body } = makeRes();
    await handler(
      makeReq('POST', rpc('tools/call', {
        name: 'get_schedule',
        arguments: { start_date: '2026-01-01', end_date: '2026-12-31' },
      })),
      res,
    );
    const result = (body() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('maximum is 93');
  });

  it('rejects malformed arguments (bad date) as an isError result', async () => {
    const { res, body } = makeRes();
    await handler(
      makeReq('POST', rpc('tools/call', {
        name: 'get_schedule',
        arguments: { start_date: 'yesterday', end_date: '2026-08-31' },
      })),
      res,
    );
    const result = (body() as { result: { isError?: boolean } }).result;
    expect(result.isError).toBe(true);
  });
});
