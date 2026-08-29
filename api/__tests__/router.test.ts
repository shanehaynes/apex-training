import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/app';
import { handleTrainingBlocks } from '../_lib/trainingBlocks';
import eventsHandler from '../_lib/handlers/events';
import analyticsTilesHandler from '../_lib/handlers/analyticsTiles';

// The router bridges to (req, res) handlers, so mocked handlers respond the
// same way the real ones do: by writing to res, never by returning a value.
vi.mock('../_lib/trainingBlocks.js', () => ({
  handleTrainingBlocks: vi.fn(async (_req: VercelRequest, res: VercelResponse) => {
    res.status(200).json({ ok: true });
  }),
}));
vi.mock('../_lib/handlers/events.js', () => ({
  default: vi.fn(async (_req: VercelRequest, res: VercelResponse) => {
    res.status(200).json({ ok: true });
  }),
}));
vi.mock('../_lib/handlers/analyticsTiles.js', () => ({
  default: vi.fn(async (_req: VercelRequest, res: VercelResponse) => {
    res.status(200).json({ ok: true });
  }),
}));

function makeReq(method: string, url: string): VercelRequest {
  return { method, url, headers: {}, query: {} } as unknown as VercelRequest;
}

function makeRes() {
  let payload: unknown;
  const res = {
    statusCode: 200,
    status(c: number) { res.statusCode = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    end(b?: unknown) { if (b !== undefined) payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse & { statusCode: number };
  return { res, statusCode: () => res.statusCode, body: () => payload };
}

beforeEach(() => {
  vi.mocked(handleTrainingBlocks).mockClear();
  vi.mocked(eventsHandler).mockClear();
  vi.mocked(analyticsTilesHandler).mockClear();
});

describe('consolidated API router', () => {
  it('dispatches /api/events to the events handler', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', '/api/events'), res);
    expect(eventsHandler).toHaveBeenCalledOnce();
    expect(statusCode()).toBe(200);
  });

  it('routes /api/blocks to handleTrainingBlocks with query.resource injected', async () => {
    const { res } = makeRes();
    const req = makeReq('GET', '/api/blocks?batch=1');
    await handler(req, res);
    expect(handleTrainingBlocks).toHaveBeenCalledOnce();
    expect(req.query.resource).toBe('block');
  });

  it('dispatches /api/analytics-tiles to the analytics tiles handler', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', '/api/analytics-tiles'), res);
    expect(analyticsTilesHandler).toHaveBeenCalledOnce();
    expect(statusCode()).toBe(200);
  });

  it('routes /api/objectives to handleTrainingBlocks as resource=objective', async () => {
    const { res } = makeRes();
    const req = makeReq('DELETE', '/api/objectives?id=abc');
    await handler(req, res);
    expect(handleTrainingBlocks).toHaveBeenCalledOnce();
    expect(req.query.resource).toBe('objective');
  });

  // Regression: Vercel's /.well-known/* rewrites hand this function the
  // ORIGINAL url, not the rewrite destination — the entrypoint must
  // normalize it or discovery 404s in prod (it did, 2026-08-11).
  it('serves protected-resource metadata from the original well-known url', async () => {
    const { res, statusCode, body } = makeRes();
    const req = makeReq('GET', '/.well-known/oauth-protected-resource');
    req.headers.host = 'apex.test';
    (req.headers as Record<string, string>)['x-forwarded-proto'] = 'https';
    await handler(req, res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ resource: 'https://apex.test/api/mcp' });
  });

  it('serves authorization-server metadata from the original well-known url', async () => {
    const { res, statusCode, body } = makeRes();
    const req = makeReq('GET', '/.well-known/oauth-authorization-server');
    req.headers.host = 'apex.test';
    (req.headers as Record<string, string>)['x-forwarded-proto'] = 'https';
    await handler(req, res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({
      issuer: 'https://apex.test',
      registration_endpoint: 'https://apex.test/api/oauth-register',
    });
  });

  it('serves /api/version through the catch-all with no auth', async () => {
    // Real handler, not a mock — it is pure env-read, and the point is that
    // the route is registered and answers without credentials.
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET', '/api/version'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toHaveProperty('sha');
  });

  it('404s unknown paths with the distinctive router message', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET', '/api/nonexistent'), res);
    expect(statusCode()).toBe(404);
    expect(String(body())).toBe('No API route: /api/nonexistent');
    expect(eventsHandler).not.toHaveBeenCalled();
    expect(handleTrainingBlocks).not.toHaveBeenCalled();
  });
});
