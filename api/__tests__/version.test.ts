import { describe, it, expect, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/version';

function makeRes() {
  let payload: unknown;
  const res = {
    statusCode: 200,
    status(c: number) { res.statusCode = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse & { statusCode: number };
  return { res, statusCode: () => res.statusCode, body: () => payload };
}

const makeReq = (method: string) => ({ method } as VercelRequest);

afterEach(() => {
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.APEX_MIN_BUILD;
  delete process.env.APEX_UPDATE_MESSAGE;
});

describe('/api/version', () => {
  it('reports the SHA Vercel stamped on the build', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
    const { res, statusCode, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ sha: '0123456789abcdef0123456789abcdef01234567', minBuild: 0 });
  });

  it('falls back to "dev" when the SHA is unset or empty', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '';
    const { res, statusCode, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ sha: 'dev', minBuild: 0 });
  });

  // The gate the app reads at launch. It is a body field, not a header:
  // app.ts's Hono bridge covers the catch-all only, so api/chat.ts and the
  // other standalone functions would never carry a header set there.
  it('publishes the minimum build the deployment serves', () => {
    process.env.APEX_MIN_BUILD = '312';
    const { res, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(body()).toEqual({ sha: 'dev', minBuild: 312 });
  });

  it('carries the update message only when one is set', () => {
    process.env.APEX_MIN_BUILD = '312';
    process.env.APEX_UPDATE_MESSAGE = 'Sign-in changed; this build can no longer save.';
    const { res, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(body()).toEqual({
      sha: 'dev',
      minBuild: 312,
      message: 'Sign-in changed; this build can no longer save.',
    });
  });

  // A typo in a dashboard field must not lock every installed build out.
  it.each(['not a number', '-1', '3.5', ''])('treats %j as no gate at all', raw => {
    process.env.APEX_MIN_BUILD = raw;
    const { res, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(body()).toEqual({ sha: 'dev', minBuild: 0 });
  });

  it('rejects non-GET methods', () => {
    const { res, statusCode } = makeRes();
    handler(makeReq('POST'), res);
    expect(statusCode()).toBe(405);
  });
});
