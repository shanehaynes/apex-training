import { describe, it, expect, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { QUERY_TOOL_NAMES } from '../_lib/handlers/query';
import { ToolInputError } from '../_lib/mcp/protocol';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn(() => ({})) }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const run = vi.fn(async (_db: unknown, userId: string, args: Record<string, unknown>) => {
  if (args.explode) throw new ToolInputError('exercise_name must be a non-empty string.');
  if (args.crash) throw new Error('db down');
  return { userId, echo: args };
});
vi.mock('../_lib/mcp/toolRegistry.js', () => ({
  MCP_TOOLS: [{ name: 'get_prs', description: '', inputSchema: {}, run: (...a: unknown[]) => run(...(a as [unknown, string, Record<string, unknown>])) }],
}));

function makeReq(body: unknown, method = 'POST'): VercelRequest {
  return { method, headers: {}, query: {}, body } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

describe('POST /api/query', () => {
  it('exposes the registry names', () => {
    expect(QUERY_TOOL_NAMES).toEqual(['get_prs']);
  });

  it('405s non-POST and 400s unknown tools and non-object args', async () => {
    const a = makeRes();
    await handler(makeReq({ tool: 'get_prs' }, 'GET'), a.res);
    expect(a.statusCode()).toBe(405);

    const b = makeRes();
    await handler(makeReq({ tool: 'drop_everything' }), b.res);
    expect(b.statusCode()).toBe(400);
    expect(String(b.body())).toContain('get_prs');

    const c = makeRes();
    await handler(makeReq({ tool: 'get_prs', args: ['x'] }), c.res);
    expect(c.statusCode()).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the tool as the JWT user and wraps the result', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ tool: 'get_prs', args: { exercise_name: 'Bench' } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ tool: 'get_prs', result: { userId: 'user-123', echo: { exercise_name: 'Bench' } } });
  });

  it('maps ToolInputError to 400 with the message, anything else to a bare 500', async () => {
    const a = makeRes();
    await handler(makeReq({ tool: 'get_prs', args: { explode: true } }), a.res);
    expect(a.statusCode()).toBe(400);
    expect(a.body()).toBe('exercise_name must be a non-empty string.');

    const b = makeRes();
    await handler(makeReq({ tool: 'get_prs', args: { crash: true } }), b.res);
    expect(b.statusCode()).toBe(500);
    expect(b.body()).toBe('Query failed');
  });
});
